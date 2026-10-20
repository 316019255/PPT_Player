/**
 * 素材后缀/媒体类型判定：零依赖，浏览器与 Node 都能引。
 * 云端上传、.pptx 浏览器导入、deck 落库校验三头都照这一份清单判格式，
 * 所以这里绝不能 import 任何 Node 内置模块 —— 客户端一引就崩。
 */

export type MediaKind = 'image' | 'video';

export interface MimeRule {
  mime: string;
  ext: string;
  kind: MediaKind;
}

// svg / html 被有意排除：它们会从站点自身源执行脚本
const ALLOWED_RULES: readonly MimeRule[] = [
  { mime: 'image/png', ext: '.png', kind: 'image' },
  { mime: 'image/jpeg', ext: '.jpg', kind: 'image' },
  { mime: 'image/webp', ext: '.webp', kind: 'image' },
  { mime: 'image/gif', ext: '.gif', kind: 'image' },
  { mime: 'image/bmp', ext: '.bmp', kind: 'image' },
  { mime: 'image/avif', ext: '.avif', kind: 'image' },
  { mime: 'video/mp4', ext: '.mp4', kind: 'video' },
  { mime: 'video/webm', ext: '.webm', kind: 'video' },
  { mime: 'video/ogg', ext: '.ogv', kind: 'video' },
  { mime: 'video/quicktime', ext: '.mov', kind: 'video' },
];

const RULES_BY_MIME = new Map(ALLOWED_RULES.map((r) => [r.mime, r]));

export function ruleForMime(mime: string): MimeRule | undefined {
  return RULES_BY_MIME.get(mime.toLowerCase().split(';')[0].trim());
}

// 允许落盘的位图后缀直接来自上传白名单
const IMAGE_STORE_EXT = new Set(ALLOWED_RULES.filter((r) => r.kind === 'image').map((r) => r.ext));
const IMAGE_EXT_ALIAS: Record<string, string> = { '.jpeg': '.jpg' };
const MIME_BY_IMAGE_EXT: Record<string, string> = Object.fromEntries(
  ALLOWED_RULES.filter((r) => r.kind === 'image').map((r) => [r.ext, r.mime])
);

const VIDEO_STORE_EXT = new Set(ALLOWED_RULES.filter((r) => r.kind === 'video').map((r) => r.ext));
const VIDEO_EXT_ALIAS: Record<string, string> = { '.ogg': '.ogv' };

/**
 * pptx 包内媒体部件路径 → 可安全使用的规范图片后缀（如 .jpg/.png）。
 * emf/wmf/tif/svg 这类浏览器渲染不了或会自执行脚本的格式、以及无后缀的部件都返回 null。
 */
export function storedImageExt(partPath: string): string | null {
  const raw = partPath.match(/\.[A-Za-z0-9]+$/)?.[0].toLowerCase() ?? '';
  const ext = IMAGE_EXT_ALIAS[raw] ?? raw;
  return IMAGE_STORE_EXT.has(ext) ? ext : null;
}

/** pptx 包内视频部件路径 → 规范后缀（.mp4/.webm/.ogv/.mov），不在白名单里返回 null */
export function storedVideoExt(partPath: string): string | null {
  const raw = partPath.match(/\.[A-Za-z0-9]+$/)?.[0].toLowerCase() ?? '';
  const ext = VIDEO_EXT_ALIAS[raw] ?? raw;
  return VIDEO_STORE_EXT.has(ext) ? ext : null;
}

/** 规范后缀 → 媒体类型；不在位图白名单里返回 undefined */
export function mimeForExt(ext: string): string | undefined {
  return MIME_BY_IMAGE_EXT[ext.toLowerCase()];
}

/** 媒体类型 → 规范后缀；svg/gif 之外非白名单类型返回 undefined */
export function extForMime(mime: string): string | null {
  const rule = ruleForMime(mime);
  return rule?.kind === 'image' ? rule.ext : null;
}

/** 视频媒体类型 → 规范后缀；非视频白名单类型返回 undefined */
export function videoExtForMime(mime: string): string | null {
  const rule = ruleForMime(mime);
  return rule?.kind === 'video' ? rule.ext : null;
}

/** 按 kind 取后缀：kind 不匹配返回 null */
export function extForMimeOfKind(mime: string, kind: MediaKind): string | null {
  const rule = ruleForMime(mime);
  return rule?.kind === kind ? rule.ext : null;
}

/**
 * 文件头魔数 → 媒体类型；认不出来就返回 null（含 svg、含各种伪装的容器）。
 *
 * 为什么要自己认：从磁盘选中的 File 可能根本没有 type，本地库里存的也可能是
 * 兜底出来的 `image/*`。云端上传要的是一个能作数的媒体类型，而服务端只看得到
 * 浏览器声称的那一个（字节不过服务器），所以入口处必须先按真实字节判一次。
 */
export function sniffImageMime(head: Uint8Array): string | null {
  const at = (i: number) => head[i];
  const text = (from: number, to: number) => String.fromCharCode(...head.slice(from, to));
  if (head.length < 12) return null;

  if (at(0) === 0x89 && text(1, 4) === 'PNG') return 'image/png';
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (text(0, 6) === 'GIF87a' || text(0, 6) === 'GIF89a') return 'image/gif';
  if (text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') return 'image/webp';
  if (text(0, 2) === 'BM') return 'image/bmp';
  // ISO-BMFF：偏移 4 是 'ftyp'，偏移 8 是主品牌。heif 的 mif1 之类不在白名单里
  if (text(4, 8) === 'ftyp' && (text(8, 12) === 'avif' || text(8, 12) === 'avis')) return 'image/avif';
  return null;
}

/**
 * 视频文件头魔数 → 媒体类型；认不出来返回 null。
 * 需要至少 12 字节（ftyp 品牌在偏移 8），调用方应提供 ≥12 字节。
 */
export function sniffVideoMime(head: Uint8Array): string | null {
  if (head.length < 12) return null;
  const text = (from: number, to: number) => String.fromCharCode(...head.slice(from, to));

  // ISO-BMFF（mp4/mov）：偏移 4 是 'ftyp'，偏移 8 是主品牌
  if (text(4, 8) === 'ftyp') {
    const brand = text(8, 12);
    if (brand === 'qt  ') return 'video/quicktime';
    // mp4 品牌：isom, iso2, mp41, mp42, avc1, hev1, hvc1, dash, M4V (iTunes), mp4v
    if (/^(?:isom|iso2|mp4[12]|avc1|hev1|hvc1|dash|M4V |mp4v)$/.test(brand)) return 'video/mp4';
  }
  // WebM / Matroska：EBML 魔数 0x1A 0x45 0xDF 0xA3
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return 'video/webm';
  }
  // Ogg：'OggS' 头（无法区分 Theora 视频和 Opus 音频，统一按 video/ogg 处理）
  if (text(0, 4) === 'OggS') return 'video/ogg';
  return null;
}

/** 图片 + 视频合一的魔数探测 */
export function sniffMediaMime(head: Uint8Array): string | null {
  return sniffImageMime(head) ?? sniffVideoMime(head);
}

/** pptx 单文件大小上限：真实课件有 60MB 级别的，浏览器解析没有请求体限制 */
export const MAX_IMPORT_FILE_BYTES = 200 * 1024 * 1024;

/** 单张图进云端桶的上限（桶配置与这里必须一致）；超过就不传云端，退回本机素材库 */
export const MEDIA_MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

/** 单个视频进云端桶的上限（Supabase 桶默认 50MB，这里留 48MB 余量） */
export const VIDEO_MAX_UPLOAD_BYTES = 48 * 1024 * 1024;

/** 按 kind 取上传上限 */
export function maxUploadBytesFor(kind: MediaKind): number {
  return kind === 'video' ? VIDEO_MAX_UPLOAD_BYTES : MEDIA_MAX_UPLOAD_BYTES;
}
