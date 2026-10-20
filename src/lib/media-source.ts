import { str } from './coerce.ts';

export const MAX_BG_VALUE_LENGTH = 2048;

/**
 * 素材地址的三种来源形态，三支互斥：
 * - https 外链 / 站内绝对路径 → 直接当 URL 用
 * - `local:<key>` → 指向浏览器 IndexedDB 里的文件，从不被当作 URL 使用
 * - `u{userId}/{sha256}{ext}` → 云端存储桶内的路径，域名不在 deck 里，渲染时才拼
 * 其它一律丢成空串，由调用方决定降级成什么。
 *
 * data:、file:、Windows 路径、//evil.com 这类值会被拼进 CSS url() 和 video src，
 * 所以只承认 https 外链或站内绝对路径。
 */

/** 站内绝对路径：排除 // 协议相对、反斜杠和空白 */
const SITEMAP_PATH = /^\/(?!\/)[^\s\\]+$/;

export const LOCAL_PREFIX = 'local:';
/** 只接受 UUID 形状的不透明 key：没有 / \ . : 空格 引号，拼不出任何 URL/scheme/路径 */
const LOCAL_KEY = /^[0-9a-zA-Z_-]{8,64}$/;

/** 'local:<key>' → '<key>'；不是这个形状就返回 ''（当作没有素材） */
export function parseLocalValue(value: unknown): string {
  const s = str(value, '', MAX_BG_VALUE_LENGTH).trim();
  if (!s.startsWith(LOCAL_PREFIX)) return '';
  const key = s.slice(LOCAL_PREFIX.length);
  return LOCAL_KEY.test(key) ? key : '';
}

/** '<key>' → 'local:<key>' */
export function localValue(key: string): string {
  return LOCAL_PREFIX + key;
}

/**
 * 外链或站内绝对路径；非法（包括 local: 前缀，保证两支互斥）返回 ''。
 * 本地素材真正进 CSS/`<video src>` 的是浏览器 URL.createObjectURL 出来的 blob:（同源、deck JSON 左右不了）。
 */
export function parseRemoteUrl(value: unknown): string {
  const s = str(value, '', MAX_BG_VALUE_LENGTH).trim();
  if (!s || s.startsWith(LOCAL_PREFIX)) return '';
  if (/^https:\/\//i.test(s) && !/\s/.test(s)) return s;
  return SITEMAP_PATH.test(s) ? s : '';
}

/**
 * 云端存储只认这一段桶内路径：{目录}/{sha256}{ext}，目录有两种 ——
 * `u{userId}` 是用户上传，`lib` 是管理员素材库（谁传的都不重要，前台共用）。
 * deck 里不存域名，所以换桶/换供应商只改配置，不必回写几百份演示文稿。
 * 后缀必须逐个列出来：形如 [a-z]{3,4} 的写法会连 .svg / .txt / .htm 一起放过，
 * 而这里要和 media-ext.ts 的白名单严格同尺寸。
 * 按 kind 拆分：图片块不能存视频路径，视频块不能存图片路径。
 */
const CLOUD_IMAGE_EXT = '(?:png|jpg|webp|gif|bmp|avif)';
const CLOUD_VIDEO_EXT = '(?:mp4|webm|ogv|mov)';
/** 管理员素材库的目录名：拼路径、判路径、正则放行，三处必须是同一个字符串 */
const LIBRARY_DIR = 'lib';
const CLOUD_DIR = `(?:u\\d+|${LIBRARY_DIR})`;
const CLOUD_PATH_IMAGE = new RegExp(`^${CLOUD_DIR}/[0-9a-f]{64}\\.${CLOUD_IMAGE_EXT}$`);
const CLOUD_PATH_VIDEO = new RegExp(`^${CLOUD_DIR}/[0-9a-f]{64}\\.${CLOUD_VIDEO_EXT}$`);
const CLOUD_PATH = new RegExp(`^${CLOUD_DIR}/[0-9a-f]{64}\\.(?:${CLOUD_IMAGE_EXT}|${CLOUD_VIDEO_EXT})$`);

/** 校验图片桶内路径；形状不符返回 '' */
export function parseCloudValue(value: unknown): string {
  const s = str(value, '', MAX_BG_VALUE_LENGTH).trim();
  return CLOUD_PATH_IMAGE.test(s) ? s : '';
}

/** 校验视频桶内路径；形状不符返回 '' */
export function parseCloudVideoValue(value: unknown): string {
  const s = str(value, '', MAX_BG_VALUE_LENGTH).trim();
  return CLOUD_PATH_VIDEO.test(s) ? s : '';
}

/**
 * 桶内路径唯一的拼法：u{userId}/{sha256}{ext}。
 * 拼完立刻回头过一遍合并正则（图片+视频后缀都收），deck 里存的值和桶里的键因此永远是同一个字符串，
 * 而 userId 之外的任何一段（包括前端传来的指纹和后缀）不合形状时都是 ''，不是半截路径。
 */
export function cloudPath(userId: number, shaHex: string, ext: string): string {
  const candidate = `u${userId}/${shaHex}${ext}`;
  return CLOUD_PATH.test(candidate) ? candidate : '';
}

/**
 * 管理员素材库的对象名：lib/{sha256}{ext}，不带上传者 id。
 * 素材是全站共用的，绑在某个人的目录里会让人误以为删那个账号就该连带删素材。
 */
export function libraryCloudPath(shaHex: string, ext: string): string {
  const candidate = `${LIBRARY_DIR}/${shaHex}${ext}`;
  return CLOUD_PATH.test(candidate) ? candidate : '';
}

/**
 * 背景用的校验：图片后缀和视频后缀都收。
 * 一条在线素材可能是图也可能是视频，而 deck 里的 cloud 背景只有「桶内路径」这一种形状，
 * 所以这里按 kind 拆开的两个 parse 都不合适，合并正则才是对的。
 */
export function parseCloudAnyValue(value: unknown): string {
  const s = str(value, '', MAX_BG_VALUE_LENGTH).trim();
  return CLOUD_PATH.test(s) ? s : '';
}

/**
 * 是不是桶内路径（图片/视频后缀都收）。素材库靠它决定背景存成 cloud 还是外链。
 * 走 parseCloudAnyValue 而不是再调一遍正则：判据只有一处，前台认定的 cloud 和
 * cloudPublicUrl 肯拼接的值才不会是两种形状。
 */
export function isCloudPath(value: string): boolean {
  return parseCloudAnyValue(value) !== '';
}

/**
 * 是不是素材库的对象名（lib/{sha256}{ext}）。
 * 后台要删桶内文件时用它把破坏面锁死在这一个目录：u{id}/ 里的东西属于上传者本人，
 * 管理员能看到别人的 deck，不等于能删别人的素材。
 */
export function isLibraryCloudPath(value: string): boolean {
  return parseCloudAnyValue(value) !== '' && value.startsWith('lib/');
}

const PUBLIC_BASE = /^https:\/\/[^\s]+$/i;

function mediaPublicBase(): string {
  return (process.env.NEXT_PUBLIC_MEDIA_PUBLIC_BASE ?? '').trim();
}

/**
 * 公开读前缀配好了没有。没配好就不该提供云端入口，
 * 也别让一个云端块画成「缺素材」让人以为图丢了。
 */
export function hasMediaBase(): boolean {
  return PUBLIC_BASE.test(mediaPublicBase());
}

/**
 * 桶内路径 → 可渲染 URL。公开读的域名前缀由 NEXT_PUBLIC_MEDIA_PUBLIC_BASE 提供
 * （形如 {SUPABASE_URL}/storage/v1/object/public/{bucket}/），拼接发生在浏览器，
 * 所以这个变量必须带 NEXT_PUBLIC_ 前缀。
 * 没配或不是 https 就返回 ''：让调用方按「缺素材」降级，而不是拼出半截 URL 去请求。
 */
export function cloudPublicUrl(path: string): string {
  const base = mediaPublicBase();
  if (!hasMediaBase()) return '';
  if (!CLOUD_PATH.test(path)) return '';
  return `${base.replace(/\/+$/, '')}/${path}`;
}

/** 原始文件名：只用于界面文案，剥控制字符并截断，永不进 URL */
export function parseMediaName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200).trim();
}
