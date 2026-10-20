/**
 * 浏览器直传云端素材桶。
 *
 * 服务端只负责签发一个绑死单条路径的一次性地址，字节从这里的 PUT 直接进桶 ——
 * 所以这一头必须先自己判清「这是不是一张位图/一段视频、有多大」，服务端看不到字节。
 */
import { extForMimeOfKind, maxUploadBytesFor, sniffMediaMime } from './media-ext.ts';
import type { MediaKind } from './media-ext.ts';

export type CloudUpload = { ok: true; path: string; reused: boolean } | { ok: false; reason: string };

/**
 * 内容指纹就是对象名：同一份文件传第二次会命中「已存在」，不重复占空间。
 * 算不出来返回 null —— WebCrypto 只在安全上下文（https 或 localhost）里存在，
 * 用 http + 局域网 IP 打开时会缺，这时宁可不传，也不编一个假指纹。
 */
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const digest = await subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

interface SignResponse {
  path?: unknown;
  mime?: unknown;
  uploadUrl?: unknown;
  token?: unknown;
  reused?: unknown;
  error?: unknown;
}

const KIND_LABEL: Record<MediaKind, string> = { image: '图片', video: '视频' };

/**
 * 申请上传地址的两个入口：用户素材走 /api/media/sign（落 u{id}/，目录由登录态决定），
 * 管理员素材库走 /api/admin/media/sign（落 lib/，全站共用）。
 * 字节那条链路一模一样，要换的只是敲哪扇门 —— 桶内路径两个路由各自在服务端拼，
 * 客户端传上来的只有指纹、媒体类型和大小，改不了自己落在谁的目录里。
 */
export const SIGN_ENDPOINT = {
  user: '/api/media/sign',
  library: '/api/admin/media/sign',
} as const;

export async function uploadMediaToCloud(
  blob: Blob,
  kind: MediaKind,
  endpoint: string = SIGN_ENDPOINT.user,
): Promise<CloudUpload> {
  const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
  const label = KIND_LABEL[kind];
  const maxBytes = maxUploadBytesFor(kind);
  if (blob.size === 0) return { ok: false, reason: '这个文件是空的' };
  if (blob.size > maxBytes) {
    return { ok: false, reason: `这个${label} ${mb(blob.size)}MB，超过单个 ${mb(maxBytes)}MB 上限，先压小一点` };
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const mime = sniffMediaMime(bytes.subarray(0, 16));
  const ext = mime ? extForMimeOfKind(mime, kind) : null;
  if (!mime || !ext) {
    const allowed = kind === 'image' ? 'png / jpg / webp / gif / bmp / avif' : 'mp4 / webm / ogg / mov';
    return { ok: false, reason: `认不出这是哪种${label}，只收 ${allowed}` };
  }

  const sha = await sha256Hex(bytes);
  if (!sha) return { ok: false, reason: '当前打开方式算不出文件指纹，请用 https 或 localhost 打开这个站点' };

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sha256: sha, mime, size: blob.size }),
    });
  } catch {
    return { ok: false, reason: '申请上传地址失败：连不上自己的服务器' };
  }

  const json = (await res.json().catch(() => null)) as SignResponse | null;
  if (typeof json?.path !== 'string' || !json.path) {
    const reason = typeof json?.error === 'string' ? json.error : `申请上传地址失败（HTTP ${res.status}）`;
    return { ok: false, reason };
  }
  // 桶里已经有同一份内容：直接把这个路径当成已就绪的地址用
  if (json.reused === true) return { ok: true, path: json.path, reused: true };
  if (typeof json.uploadUrl !== 'string' || typeof json.token !== 'string') {
    return { ok: false, reason: '服务器没有给回可用的上传地址' };
  }

  let put: Response;
  try {
    put = await fetch(json.uploadUrl, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${json.token}`, 'content-type': mime, 'x-upsert': 'false' },
      body: blob,
    });
  } catch {
    return { ok: false, reason: '上传中断了，检查网络后再试一次' };
  }
  if (put.ok) return { ok: true, path: json.path, reused: false };

  // 两个标签页同时传同一份文件，后落地的那个会被桶报「已存在」——内容一样，同样算成功
  const body = await put.text().catch(() => '');
  if (body.includes('KeyAlreadyExists') || body.includes('already exists')) {
    return { ok: true, path: json.path, reused: true };
  }
  // 桶自己拒收的理由（比如 mime 不在桶的白名单里、超出桶级大小上限）只有这句说得清，别只报状态码
  let why = '';
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    const reason = typeof parsed?.error === 'string' ? parsed.error : parsed?.message;
    if (typeof reason === 'string' && reason.trim()) why = '：' + reason.trim().slice(0, 90);
  } catch {
    /* 桶回的不是 JSON 就只报状态码 */
  }
  return { ok: false, reason: `上传失败（HTTP ${put.status}）${why}` };
}

/** 向后兼容别名：只传图片 */
export function uploadImageToCloud(blob: Blob): Promise<CloudUpload> {
  return uploadMediaToCloud(blob, 'image');
}

/** 格子预览的最大宽度：和浏览器本机素材库那套对齐（localMaterials.ts 的 THUMB_MAX_W） */
const THUMB_MAX_W = 320;
const THUMB_QUALITY = 0.72;

/**
 * 云端图片素材的缩略图在浏览器里生成、跟着原图一起进桶。
 * 不做这一步，编辑器每打开一次就要把每张 1920px 的原图当格子背景拉一遍 ——
 * 在线素材是全站共用的，几十条原图就是几十 MB 白送流量，而格子只有 320px 宽。
 *
 * 解不开就返回 null，让调用方按「没有缩略图」处理：缩略图是省流量的附加品，
 * 传不出来不该把整次上传判死。
 * 只在函数体里碰 createImageBitmap / canvas —— 这个模块被 Node 单测 import 着算 sha256Hex。
 */
export async function makeImageThumb(blob: Blob): Promise<Blob | null> {
  let bmp: ImageBitmap;
  try {
    // 限宽解码：解得开也顺手把尺寸压下来了，坏字节在这里就抛
    bmp = await createImageBitmap(blob, { resizeWidth: THUMB_MAX_W, resizeQuality: 'high' });
  } catch (err) {
    // 不认 resize 选项的老浏览器报 NotSupportedError，退成全量解码再缩着画
    if (!(err instanceof DOMException && err.name === 'NotSupportedError')) return null;
    try {
      bmp = await createImageBitmap(blob);
    } catch {
      return null;
    }
  }

  try {
    const scale = Math.min(1, THUMB_MAX_W / bmp.width);
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    // JPEG 没有透明通道：先铺一层和放映兜底一致的底色，不然 PNG 的透明区出来是黑的
    const draw = (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) => {
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bmp, 0, 0, w, h);
    };
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      draw(ctx);
      return await canvas.convertToBlob({ type: 'image/jpeg', quality: THUMB_QUALITY });
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    draw(ctx);
    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', THUMB_QUALITY)
    );
  } catch {
    return null;
  } finally {
    bmp.close();
  }
}

/**
 * 视频缩略图：提取第一帧（t=0.1s，避开某些编解码器的黑屏起始帧）画到 canvas 上导出 JPEG。
 * 和视频原文件一起进桶，前台格子只拉这张 320px 的图，不拉整段视频。
 *
 * 失败返回 null：缩略图是附加品，提取不出来就让格子直接拉视频本身（preload="metadata" 只取第一帧）。
 * 只在函数体里碰 HTMLVideoElement / canvas —— 同上，Node 测不了这段。
 */
export async function makeVideoThumb(blob: Blob): Promise<Blob | null> {
  const videoUrl = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.playsInline = true;

  try {
    // 等元数据（时长、尺寸）回来才能 seek
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('video metadata failed'));
      video.src = videoUrl;
    });

    // seek 到 0.1s：某些 mp4 的 0s 是黑屏，0.1s 通常已经是第一帧画面
    const seekTime = Math.min(0.1, video.duration * 0.01);
    video.currentTime = seekTime;

    // 等 seek 完成 + 第一帧画好
    await new Promise<void>((resolve) => {
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        resolve();
      };
      video.addEventListener('seeked', onSeeked);
    });

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;

    const scale = Math.min(1, THUMB_MAX_W / vw);
    const w = Math.max(1, Math.round(vw * scale));
    const h = Math.max(1, Math.round(vh * scale));

    const draw = (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) => {
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(video, 0, 0, w, h);
    };

    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      draw(ctx);
      return await canvas.convertToBlob({ type: 'image/jpeg', quality: THUMB_QUALITY });
    }

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    draw(ctx);
    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', THUMB_QUALITY)
    );
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(videoUrl);
  }
}
