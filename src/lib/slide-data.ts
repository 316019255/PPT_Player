import type { Background, ImageBlock, ImageFit, ImageSource, Slide, TextBlock, VideoBlock, VideoSource } from '@/types/ppt';
import { color, num, str } from './coerce.ts';
import {
  LOCAL_PREFIX,
  MAX_BG_VALUE_LENGTH,
  localValue,
  parseCloudAnyValue,
  parseCloudValue,
  parseCloudVideoValue,
  parseLocalValue,
  parseMediaName,
  parseRemoteUrl,
} from './media-source.ts';

export const MAX_SLIDES = 500;
/** 单页「文字块 + 图片块」合计上限：两者共用同一层缩放舞台，一起算才挡得住堆料 */
export const MAX_BLOCKS_PER_SLIDE = 100;
export const MAX_TEXT_LENGTH = 5000;
export { MAX_BG_VALUE_LENGTH };
/** 序列化后允许的最大字节数，避免单个演示文稿把库和内存撑爆 */
export const MAX_DATA_BYTES = 2 * 1024 * 1024;

const BG_TYPES = new Set<Background['type']>(['none', 'color', 'image', 'video', 'local', 'cloud']);
const FONT_WEIGHTS = new Set(['normal', 'bold']);
const FONT_STYLES = new Set(['normal', 'italic']);
const TEXT_ALIGNMENTS = new Set(['left', 'center', 'right']);
const IMAGE_FITS = new Set<ImageFit>(['fill', 'contain', 'cover']);

export type ParseResult = { ok: true; slides: Slide[] } | { ok: false; reason: string };

/** 'local:<key>' → '<key>'；不是这个形状就返回 ''（当作无背景）。住在 media-source，这里保留旧导入路径 */
export { parseLocalValue as parseLocalKey };

/**
 * 三种来源各走自己的校验，互斥；'part'（pptx 导入时的一次性占位）和未知 kind 一律拒。
 * 一次性占位从不该进 HTTP：任何存库路径都要丢块，而不是指望调用方先转换。
 * value 存回去必须和读进来一字不差，所以 local 分支要把 parseLocalValue 剥掉的 'local:' 前缀补回来。
 */
function parseImageSource(raw: unknown): ImageSource | null {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as Record<string, unknown>;
  if (src.kind === 'local') {
    const key = parseLocalValue(src.value);
    return key ? { kind: 'local', value: localValue(key) } : null;
  }
  if (src.kind === 'cloud') {
    const value = parseCloudValue(src.value);
    return value ? { kind: 'cloud', value } : null;
  }
  if (src.kind === 'remote') {
    const value = parseRemoteUrl(src.value);
    return value ? { kind: 'remote', value } : null;
  }
  return null;
}

const IMAGE_GEOMETRY = { x: 20, y: 20, width: 60, height: 60 };

/** 单块非法只丢这一块：地址不合法的图渲染出来是空白，留着比丢掉更容易骗过编辑者 */
function parseImageBlock(raw: unknown): ImageBlock | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  const src = parseImageSource(b.src);
  if (!src) return null;
  const { x, width, y, height } = pickGeometry(b, IMAGE_GEOMETRY);

  return {
    id: str(b.id, crypto.randomUUID(), 64),
    src,
    x,
    y,
    width,
    height,
    ...(IMAGE_FITS.has(b.fit as ImageFit) ? { fit: b.fit as ImageFit } : {}),
    ...(typeof b.alt === 'string' && b.alt.trim() ? { alt: parseMediaName(b.alt) } : {}),
    zIndex: num(b.zIndex, 1, 1, 999),
  };
}

/**
 * 视频来源校验：和图片各走各的桶内路径正则，
 * 图片块不能存视频路径，视频块不能存图片路径。
 */
function parseVideoSource(raw: unknown): VideoSource | null {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as Record<string, unknown>;
  if (src.kind === 'local') {
    const key = parseLocalValue(src.value);
    return key ? { kind: 'local', value: localValue(key) } : null;
  }
  if (src.kind === 'cloud') {
    const value = parseCloudVideoValue(src.value);
    return value ? { kind: 'cloud', value } : null;
  }
  if (src.kind === 'remote') {
    const value = parseRemoteUrl(src.value);
    return value ? { kind: 'remote', value } : null;
  }
  return null;
}

/** 单块非法只丢这一块，不拒绝整 deck */
function parseVideoBlock(raw: unknown): VideoBlock | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  const src = parseVideoSource(b.src);
  if (!src) return null;
  const { x, width, y, height } = pickGeometry(b, IMAGE_GEOMETRY);

  return {
    id: str(b.id, crypto.randomUUID(), 64),
    src,
    x,
    y,
    width,
    height,
    ...(IMAGE_FITS.has(b.fit as ImageFit) ? { fit: b.fit as ImageFit } : {}),
    ...(typeof b.alt === 'string' && b.alt.trim() ? { alt: parseMediaName(b.alt) } : {}),
    ...(typeof b.poster === 'string' && parseRemoteUrl(b.poster) ? { poster: parseRemoteUrl(b.poster) } : {}),
    ...(b.loop === true ? { loop: true } : {}),
    ...(b.muted === false ? { muted: false } : {}),
    ...(b.controls === true ? { controls: true } : {}),
    zIndex: num(b.zIndex, 1, 1, 999),
  };
}

/** 百分比几何：四个数互相夹范围（width/height 都不能越过 x/y 剩下的空间） */
export function pickGeometry(
  block: Record<string, unknown>,
  defaults: { x: number; y: number; width: number; height: number }
): { x: number; width: number; y: number; height: number } {
  const x = num(block.x, defaults.x, 0, 100);
  const width = num(block.width, defaults.width, 1, 100 - x);
  const y = num(block.y, defaults.y, 0, 100);
  const height = num(block.height, defaults.height, 1, 100 - y);
  return { x, width, y, height };
}

const TEXT_GEOMETRY = { x: 10, y: 30, width: 80, height: 12 };

/**
 * 数据库/请求体里的内容都不可信：这里把任意 JSON 收敛成合法 Slide[]，
 * 越界的数字、非法颜色、超大文本都会被修正，结构不合法时整体拒绝。
 */
export function parseSlides(value: unknown): ParseResult {
  if (!Array.isArray(value)) return { ok: false, reason: '幻灯片数据必须是数组' };
  if (value.length === 0) return { ok: false, reason: '演示文稿至少需要一页' };
  if (value.length > MAX_SLIDES) return { ok: false, reason: `最多 ${MAX_SLIDES} 页` };

  const slides: Slide[] = [];

  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return { ok: false, reason: '幻灯片结构不合法' };
    const item = raw as Record<string, unknown>;

    const bg = (item.background ?? {}) as Record<string, unknown>;
    const declaredType = BG_TYPES.has(bg.type as Background['type'])
      ? (bg.type as Background['type'])
      : 'color';
    let type = declaredType;
    let value: string;
    let name: string | undefined;
    if (declaredType === 'color') {
      value = color(bg.value, '#1a1a2e');
    } else if (declaredType === 'local') {
      const key = parseLocalValue(bg.value);
      value = key ? LOCAL_PREFIX + key : '';
      // name 只随 local/cloud 保留：仅界面文案用；非法值一并丢弃
      if (value) name = parseMediaName(bg.name);
      if (!value) type = 'none';
    } else if (declaredType === 'cloud') {
      // 只承认 {u{id}|lib}/{sha256}{ext}：桶内路径写歪一个字符，拼出来的就是别人的对象或半截 URL
      // 图片和视频后缀都收，具体按哪种渲染由 SlideStage 照后缀嗅探
      value = parseCloudAnyValue(bg.value);
      if (value) name = parseMediaName(bg.name);
      if (!value) type = 'none';
    } else {
      value = parseRemoteUrl(bg.value);
      // 地址不合法就当没有背景，避免渲染出指向页面自身的 video src=""
      if (!value) type = 'none';
    }
    const background: Background = name ? { type, value, name } : { type, value };

    const rawBlocks = item.textBlocks;
    if (!Array.isArray(rawBlocks)) return { ok: false, reason: '文字块数据不合法' };

    const rawImages = item.imageBlocks;
    // 老数据没有这个字段 → 空数组；写了但不是数组 → 结构不合法，整体拒绝
    if (rawImages !== undefined && !Array.isArray(rawImages)) {
      return { ok: false, reason: '图片块数据不合法' };
    }
    const rawImageList: unknown[] = rawImages ?? [];

    const rawVideos = item.videoBlocks;
    if (rawVideos !== undefined && !Array.isArray(rawVideos)) {
      return { ok: false, reason: '视频块数据不合法' };
    }
    const rawVideoList: unknown[] = rawVideos ?? [];

    if (rawBlocks.length + rawImageList.length + rawVideoList.length > MAX_BLOCKS_PER_SLIDE) {
      return { ok: false, reason: `单页最多 ${MAX_BLOCKS_PER_SLIDE} 个元素（文字块 + 图片块 + 视频块）` };
    }

    const textBlocks: TextBlock[] = rawBlocks.map((b) => {
      const block = (b ?? {}) as Record<string, unknown>;
      const { x, width, y, height } = pickGeometry(block, TEXT_GEOMETRY);

      return {
        id: str(block.id, crypto.randomUUID(), 64),
        text: str(block.text, '', MAX_TEXT_LENGTH),
        x,
        y,
        width,
        height,
        fontSize: num(block.fontSize, 24, 8, 400),
        color: color(block.color, '#ffffff'),
        ...(block.opacity === undefined ? {} : { opacity: num(block.opacity, 1, 0, 1) }),
        fontWeight: FONT_WEIGHTS.has(block.fontWeight as string)
          ? (block.fontWeight as TextBlock['fontWeight'])
          : 'normal',
        fontStyle: FONT_STYLES.has(block.fontStyle as string)
          ? (block.fontStyle as TextBlock['fontStyle'])
          : 'normal',
        textAlign: TEXT_ALIGNMENTS.has(block.textAlign as string)
          ? (block.textAlign as TextBlock['textAlign'])
          : 'left',
        ...(typeof block.fontFamily === 'string' && block.fontFamily.trim()
          ? { fontFamily: str(block.fontFamily, '', 120) }
          : {}),
        ...(block.wrap === false ? { wrap: false } : {}),
        bgColor: color(block.bgColor, ''),
        bgOpacity: num(block.bgOpacity, 1, 0, 1),
        borderRadius: num(block.borderRadius, 0, 0, 200),
        padding: num(block.padding, 4, 0, 200),
        borderColor: color(block.borderColor, ''),
        borderWidth: num(block.borderWidth, 0, 0, 50),
        zIndex: num(block.zIndex, 1, 1, 999),
      };
    });

    const imageBlocks: ImageBlock[] = [];
    for (const raw of rawImageList) {
      const image = parseImageBlock(raw);
      if (image) imageBlocks.push(image);
    }

    const videoBlocks: VideoBlock[] = [];
    for (const raw of rawVideoList) {
      const video = parseVideoBlock(raw);
      if (video) videoBlocks.push(video);
    }

    slides.push({
      id: str(item.id, crypto.randomUUID(), 64),
      background,
      textBlocks,
      imageBlocks,
      videoBlocks,
    });
  }

  return { ok: true, slides };
}

/** 读取库里已存的 JSON 文本；失败时返回空数组，由调用方决定如何呈现 */
export function readStoredSlides(raw: string | null | undefined): Slide[] {
  if (!raw) return [];
  try {
    const parsed = parseSlides(JSON.parse(raw) as unknown);
    return parsed.ok ? parsed.slides : [];
  } catch {
    return [];
  }
}

export type SerializeResult =
  | { ok: true; slides: Slide[]; json: string }
  | { ok: false; reason: string };

/** 写入前统一走这里：校验 + 归一化 + 体积上限 */
export function serializeSlides(value: unknown): SerializeResult {
  const result = parseSlides(value);
  if (!result.ok) return result;
  const json = JSON.stringify(result.slides);
  if (Buffer.byteLength(json, 'utf8') > MAX_DATA_BYTES) {
    return { ok: false, reason: `演示文稿数据过大（最大 ${Math.round(MAX_DATA_BYTES / 1024)}KB）` };
  }
  return { ok: true, slides: result.slides, json };
}
