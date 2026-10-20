/**
 * .pptx 导入的编排层：解包 → 解析 → 逐张取字节交给 sink → 把结果填回 slides。
 *
 * 字节到底存到哪（云端桶还是本机库）由注入进来的 resolveMedia 决定，这一层只管四件事：
 * 哪些部件值得读、读不到时怎么降级、单页元素超限先丢谁，
 * 以及在一张图都还没上传之前先估一遍这份 deck 存不存得下——传完几百张才被告知超限是最亏的失败。
 * 因为不碰 IndexedDB 也不碰 fetch，这条链路在 Node 里拿一个假 resolver 就能整条测。
 */
import { importSlides } from './pptx.ts';
import { unpackPptx, type PptxPackageData } from './pptx-pack.ts';
import { storedImageExt } from './media-ext.ts';
import { MAX_BLOCKS_PER_SLIDE, MAX_DATA_BYTES, MAX_SLIDES } from './slide-data.ts';
import type { Background, ImageSource, Slide } from '@/types/ppt';

export type MediaResolution = { ok: true; src: ImageSource } | { ok: false; reason: string };

/** part 是包内路径，bytes 是它的原始字节；实现方负责存好并回到三种来源之一 */
export type MediaResolver = (part: string, bytes: Uint8Array<ArrayBuffer>) => Promise<MediaResolution>;

export interface ImportProgress {
  phase: 'unpack' | 'media' | 'assemble';
  done: number;
  total: number;
}

export interface PptxImportInput {
  data: PptxPackageData;
  resolveMedia: MediaResolver;
  onProgress?: (progress: ImportProgress) => void;
}

export interface PptxImportOutcome {
  slides: Slide[];
  warnings: string[];
  skipped: { pictures: number; videos: number; charts: number };
  images: { placed: number; backgrounds: number; dropped: number };
}

/** 一个来源解析完之后大概要占多少字节，粗估上限用；真正的裁决仍是服务端 serializeSlides */
const IMAGE_BLOCK_BYTES = 260;
const BACKGROUND_BYTES = 120;

const encoder = new TextEncoder();

/** 三种来源各回到背景模型里对应的那一支：桶内路径必须走 cloud，不能伪装成 https 外链 */
function backgroundFrom(src: ImageSource): Background {
  if (src.kind === 'cloud') return { type: 'cloud', value: src.value };
  if (src.kind === 'local') return { type: 'local', value: src.value };
  return { type: 'image', value: src.value };
}

function uniqueParts(slots: { part: string }[], backgrounds: { part: string }[]): string[] {
  return [...new Set([...slots.map((s) => s.part), ...backgrounds.map((b) => b.part)])];
}

/**
 * 单页「文字块 + 图片块」合计有硬上限，而 parseSlides 对超限是整篇拒绝，所以这里必须先削好。
 * 丢的顺序：没有文字的装饰色块 → 图片块 → 正文文字，越靠后越舍不得。
 */
function trimSlidesToCap(slides: Slide[]): { decorative: number; images: number; text: number } {
  const dropped = { decorative: 0, images: 0, text: 0 };

  for (const slide of slides) {
    const total = () => slide.textBlocks.length + slide.imageBlocks.length;

    for (let i = slide.textBlocks.length - 1; i >= 0 && total() > MAX_BLOCKS_PER_SLIDE; i--) {
      if (slide.textBlocks[i].text.trim() === '') {
        slide.textBlocks.splice(i, 1);
        dropped.decorative++;
      }
    }
    while (total() > MAX_BLOCKS_PER_SLIDE && slide.imageBlocks.length > 0) {
      slide.imageBlocks.pop();
      dropped.images++;
    }
    while (total() > MAX_BLOCKS_PER_SLIDE && slide.textBlocks.length > 0) {
      slide.textBlocks.pop();
      dropped.text++;
    }
  }

  return dropped;
}

/** 失败原因相同的合并成一行，最多列 3 类，免得几十条告警把顶部提示撑满 */
function summarizeDropped(dropped: Map<string, string>): string[] {
  const counts = new Map<string, number>();
  for (const reason of dropped.values()) counts.set(reason, (counts.get(reason) ?? 0) + 1);

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const lines = sorted.slice(0, 3).map(([reason, n]) => `${n} 张图片没能带进来：${reason}`);
  const rest = sorted.slice(3);
  if (rest.length) lines.push(`另有 ${rest.reduce((n, [, c]) => n + c, 0)} 张图片是别的原因，没带进来`);
  return lines;
}

export async function importPptx(input: PptxImportInput): Promise<PptxImportOutcome> {
  const { data, resolveMedia, onProgress } = input;

  onProgress?.({ phase: 'unpack', done: 0, total: 0 });
  const pack = await unpackPptx(data);
  const report = importSlides(pack.sources, { presentationXml: pack.presentationXml, parts: pack.parts });
  if (pack.truncated) {
    report.warnings.push(`共 ${pack.slideCount} 页，超过 ${MAX_SLIDES} 页的上限，只导入了前 ${MAX_SLIDES} 页`);
  }

  const wanted = uniqueParts(report.imageSlots, report.imageBackgrounds);

  // 上传之前先估体积：宁可现在说，也别传完几百张之后再拒
  const estimate =
    encoder.encode(JSON.stringify(report.slides)).length +
    wanted.length * IMAGE_BLOCK_BYTES +
    report.imageBackgrounds.length * BACKGROUND_BYTES;
  if (estimate > MAX_DATA_BYTES) {
    throw new Error(
      `这份内容序列化后大约 ${Math.round(estimate / 1024)}KB，超过单个演示文稿 ${Math.round(MAX_DATA_BYTES / 1024)}KB 的上限，先拆成几份导入吧`
    );
  }

  const srcByPart = new Map<string, ImageSource>();
  const dropped = new Map<string, string>();
  let done = 0;

  for (const part of wanted) {
    done++;
    onProgress?.({ phase: 'media', done, total: wanted.length });

    // 后缀先过一遍：emf/wmf/tif/svg 既进不了云端桶也进不了本机库，没必要白读字节再让浏览器解一遍码
    if (!storedImageExt(part)) {
      dropped.set(part, '这种格式浏览器画不出来（emf/wmf/tif/svg 之类）');
      continue;
    }
    const bytes = await pack.readMedia(part);
    if (!bytes) {
      dropped.set(part, '关系表指向的文件在包里找不到');
      continue;
    }
    const resolved = await resolveMedia(part, bytes);
    if (resolved.ok) srcByPart.set(part, resolved.src);
    else dropped.set(part, resolved.reason);
  }

  onProgress?.({ phase: 'assemble', done: 0, total: 0 });

  const byId = new Map(report.slides.map((slide) => [slide.id, slide]));
  let placed = 0;
  let backgrounds = 0;

  for (const slot of report.imageSlots) {
    const slide = byId.get(slot.slideId);
    const src = srcByPart.get(slot.part);
    if (!slide || !src) continue;
    slide.imageBlocks.push({
      id: crypto.randomUUID(),
      src,
      x: slot.x,
      y: slot.y,
      width: slot.width,
      height: slot.height,
      fit: slot.fit,
      ...(slot.alt ? { alt: slot.alt } : {}),
      zIndex: slot.zIndex,
    });
    placed++;
  }

  for (const ref of report.imageBackgrounds) {
    const slide = byId.get(ref.slideId);
    const src = srcByPart.get(ref.part);
    if (!slide || !src) continue;
    slide.background = backgroundFrom(src);
    backgrounds++;
  }

  const droppedBackgrounds = report.imageBackgrounds.filter((ref) => dropped.has(ref.part));
  const trimmed = trimSlidesToCap(report.slides);

  report.warnings.push(...summarizeDropped(dropped));
  if (droppedBackgrounds.length) {
    report.warnings.push(`${droppedBackgrounds.length} 页的图片背景没能带进来，这些页用的是纯色底`);
  }
  if (trimmed.decorative || trimmed.images || trimmed.text) {
    report.warnings.push(
      `单页最多 ${MAX_BLOCKS_PER_SLIDE} 个元素（文字 + 图片），共丢弃 ${trimmed.decorative} 个装饰色块、${trimmed.images} 张图片、${trimmed.text} 个文字块`
    );
  }

  return {
    slides: report.slides,
    warnings: report.warnings,
    skipped: report.skipped,
    images: { placed, backgrounds, dropped: dropped.size },
  };
}
