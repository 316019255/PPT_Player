import { maxUploadBytesFor, ruleForMime, type MediaKind } from './media-ext.ts';

/** 内容指纹就是文件名的一部分：只认 64 位小写十六进制，别的形状一律不要 */
const SHA_HEX = /^[0-9a-f]{64}$/;

export type UploadRequest =
  | { ok: true; sha256: string; mime: string; size: number; kind: MediaKind; ext: string }
  | { ok: false; status: number; error: string };

const KIND_LABEL: Record<MediaKind, string> = { image: '图片', video: '视频' };

/**
 * 「申请上传」有两个入口：用户自己的 `u{id}/` 目录和管理员素材库的 `lib/`。
 * 要判的是同一件事，判两遍迟早会一边松一边紧 —— 松的那头签得出的后缀，
 * 紧的那头（deck 落库校验）会当场把它判成「没有背景」，用户看到的是传成功了却显示不出来。
 * 所以形状判定只写在这里，两个路由都照这一份走。
 *
 * 后缀一律由媒体类型反推，绝不采信请求里直接给的后缀：否则 `x.png` 里塞的是 html。
 */
export function readUploadRequest(body: unknown): UploadRequest {
  // null、"abc"、[1,2] 都解析得过去，一按属性取值就是 TypeError：两种都是调用方的错，得是 400
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: '请求体得是一个对象' };
  }
  const { sha256, mime, size } = body as Record<string, unknown>;

  if (typeof sha256 !== 'string' || !SHA_HEX.test(sha256)) {
    return { ok: false, status: 400, error: '文件指纹不合法' };
  }

  const rule = typeof mime === 'string' ? ruleForMime(mime) : undefined;
  if (!rule) {
    return {
      ok: false,
      status: 400,
      error: '只收图片（png / jpg / webp / gif / bmp / avif）和视频（mp4 / webm / ogg / mov）',
    };
  }

  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) {
    return { ok: false, status: 400, error: '文件大小不合法' };
  }
  const maxBytes = maxUploadBytesFor(rule.kind);
  if (size > maxBytes) {
    const mb = (maxBytes / 1024 / 1024).toFixed(0);
    return { ok: false, status: 413, error: `这个${KIND_LABEL[rule.kind]}超过单个 ${mb}MB 上限，先压小一点再传` };
  }

  return { ok: true, sha256, mime: rule.mime, size, kind: rule.kind, ext: rule.ext };
}
