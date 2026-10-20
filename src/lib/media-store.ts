/**
 * 云端素材桶（Supabase Storage）的服务端封装。
 *
 * **只有服务端能引这个文件**：它手里握着 SUPABASE_SECRET_KEY。
 * 浏览器只拿到一次性、绑死单个路径、短期有效的上传地址，
 * 所以它既看不见 secret，也改不了别人的目录（实测：公开 key 连签发都过不了 RLS）。
 *
 * 上传走「服务端签发 + 浏览器直传」而不是把字节送回 API：Vercel 的函数请求体约 4.5MB，
 * 一张正常的课件图就能超；直传把上限抬到桶自己配置的 12MB。
 */

import { isLibraryCloudPath } from './media-source.ts';

export type UploadLink =
  | { kind: 'signed'; url: string; token: string }
  /** 桶里已经有同样内容的对象 —— 内容寻址下这就是去重命中，不是失败 */
  | { kind: 'exists' }
  | { kind: 'error'; reason: string };

interface StorageConfig {
  base: string;
  key: string;
  bucket: string;
}

function readConfig(): { ok: true; cfg: StorageConfig } | { ok: false; reason: string } {
  const base = (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '');
  const key = (process.env.SUPABASE_SECRET_KEY ?? '').trim();
  const bucket = (process.env.SUPABASE_MEDIA_BUCKET ?? '').trim() || 'slide-media';
  if (!base || !key) {
    return {
      ok: false,
      reason: '云端存储还没配置：需要 SUPABASE_URL 和 SUPABASE_SECRET_KEY，并先跑 npm run media:setup 建桶',
    };
  }
  return { ok: true, cfg: { base, key, bucket } };
}

/** 签发一次上传地址。path 必须已经是 {u{userId}|lib}/{sha256}{ext} 的形状 —— 由调用方保证。 */
export async function createUploadLink(path: string): Promise<UploadLink> {
  const conf = readConfig();
  if (!conf.ok) return { kind: 'error', reason: conf.reason };
  const { cfg } = conf;

  let res: Response;
  try {
    res = await fetch(`${cfg.base}/storage/v1/object/upload/sign/${cfg.bucket}/${path}`, {
      method: 'POST',
      headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ bucket_id: cfg.bucket }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { kind: 'error', reason: timedOut ? '连接云端存储超时了，稍后再试一次' : '连不上云端存储' };
  }

  const text = await res.text();
  if (res.ok) {
    let rel: unknown;
    try {
      rel = (JSON.parse(text) as { url?: unknown }).url;
    } catch {
      rel = undefined;
    }
    // 真实形态：{url:"/object/upload/sign/{bucket}/{path}?token={jwt}"}，是相对存储根的地址
    if (typeof rel !== 'string' || !rel.startsWith('/')) return { kind: 'error', reason: '云端存储没有返回可用的上传地址' };
    const absolute = new URL(`${cfg.base}/storage/v1${rel}`);
    const token = absolute.searchParams.get('token') ?? '';
    if (!token) return { kind: 'error', reason: '云端存储返回的上传地址缺少令牌' };
    return { kind: 'signed', url: absolute.toString(), token };
  }

  // Supabase 把真实状态码写在包体里：HTTP 400 包 {statusCode:"409",code:"KeyAlreadyExists"}。
  // 只看 res.status 会把「已经传过了」当成故障，所以这里按包体判断。
  if (text.includes('KeyAlreadyExists')) return { kind: 'exists' };
  const message = (text.match(/"message"\s*:\s*"([^"]{1,200})"/) ?? [])[1];
  return { kind: 'error', reason: `云端存储拒绝了这次上传（HTTP ${res.status}${message ? `：${message}` : ''}）` };
}

export type DeleteResult =
  | { kind: 'deleted' }
  /** 桶里本来就没有这个对象：重复删除或已被清理，目的已经达到，不该报成故障 */
  | { kind: 'missing' }
  | { kind: 'error'; reason: string };

/**
 * 真删桶内对象 —— 不可逆。素材「下线」只是前台看不见，已引用它的稿子照常放映；
 * 文件删了，那些稿子的背景就再也渲染不出来。
 * 所以这一层只认 lib/ 目录：u{id}/ 里的字节属于上传者本人，管理员能看到别人的 deck
 * 不等于能删别人的素材。这个限制写在能力本身上，不写在调用方，绕不过去。
 */
export async function deleteCloudObject(path: string): Promise<DeleteResult> {
  if (!isLibraryCloudPath(path)) {
    return { kind: 'error', reason: '只能删除素材库目录（lib/）里的对象' };
  }

  const conf = readConfig();
  if (!conf.ok) return { kind: 'error', reason: conf.reason };
  const { cfg } = conf;

  let res: Response;
  try {
    res = await fetch(`${cfg.base}/storage/v1/object/${cfg.bucket}/${path}`, {
      method: 'DELETE',
      headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { kind: 'error', reason: timedOut ? '连接云端存储超时了，稍后再试一次' : '连不上云端存储' };
  }

  if (res.ok) return { kind: 'deleted' };
  // 同 createUploadLink：Supabase 把真实状态码写在包体里（不存在的键是 HTTP 400 包 "404"），
  // 只看 res.status 会把「已经没了」报成故障，管理员会以为删除失败而反复点。
  const body = await res.text().catch(() => '');
  if (res.status === 404 || body.includes('not found') || body.includes('"404"')) {
    return { kind: 'missing' };
  }
  const message = (body.match(/"message"\s*:\s*"([^"]{1,200})"/) ?? [])[1];
  return { kind: 'error', reason: `云端存储拒绝删除（HTTP ${res.status}${message ? `：${message}` : ''}）` };
}
