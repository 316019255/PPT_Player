/**
 * 云端素材桶的配置与自检。
 *
 *   node --env-file=.env.local scripts/storage-setup.mjs            # 建桶/改桶（可重复跑）
 *   node --env-file=.env.local scripts/storage-setup.mjs --verify    # 再跑一遍实测清单
 *
 * 只做两件事：把桶的配置钉成代码里这一份，以及验证「浏览器只拿一次性 token 就能传、
 * 任何人不要 key 也能读、但既列不出目录也自己签不出上传地址」。
 * 需要 SUPABASE_SECRET_KEY（服务端专用，绝不能进浏览器包）。
 */
import { createHash, randomBytes } from 'crypto';

const base = (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '');
const secret = (process.env.SUPABASE_SECRET_KEY ?? '').trim();
const anon = (process.env.SUPABASE_PUBLISHABLE_KEY ?? '').trim();
const BUCKET = (process.env.SUPABASE_MEDIA_BUCKET ?? '').trim() || 'slide-media';
const MAX_BYTES = 48 * 1024 * 1024;
// 与 src/lib/media-ext.ts 的白名单保持一致：svg/html 会被桶直接拒收
const MIME_TYPES = [
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/avif',
  'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime',
];

if (!base || !secret) {
  console.error('缺少 SUPABASE_URL 或 SUPABASE_SECRET_KEY。两者都只在服务端用，不要加 NEXT_PUBLIC_ 前缀。');
  process.exit(1);
}

const secretHeaders = (extra = {}) => ({ apikey: secret, Authorization: `Bearer ${secret}`, ...extra });

/**
 * Supabase 把真实状态码写在包体里：HTTP 400 包 {statusCode:"409"} 才是「已存在」，
 * 只看 res.status 会把去重信号当成故障。
 */
async function call(label, method, path, { headers = secretHeaders(), body, soft = false } = {}) {
  const res = await fetch(base + path, { method, headers, body });
  const text = await res.text();
  const wrapped = Number(text.match(/"statusCode"\s*:\s*"?(\d{3})"?/)?.[1] ?? res.status);
  const status = res.ok ? res.status : wrapped;
  if (!res.ok && status !== 409 && !(soft && status === 404)) {
    throw new Error(`${label} 失败：HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return { status, text };
}

// ===== 1. 桶配置（幂等） =====
const config = { public: true, file_size_limit: MAX_BYTES, allowed_mime_types: MIME_TYPES };
const created = await call('创建桶', 'POST', '/storage/v1/bucket', {
  headers: secretHeaders({ 'content-type': 'application/json' }),
  body: JSON.stringify({ id: BUCKET, name: BUCKET, ...config }),
});
if (created.status === 409) {
  await call('更新桶', 'PUT', `/storage/v1/bucket/${BUCKET}`, {
    headers: secretHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(config),
  });
  console.log(`桶「${BUCKET}」已存在，配置已刷新为：公开读 · 单文件 ≤${MAX_BYTES / 1024 / 1024}MB · 收图片+视频`);
} else {
  console.log(`桶「${BUCKET}」已创建：公开读 · 单文件 ≤${MAX_BYTES / 1024 / 1024}MB · 收图片+视频`);
}

console.log('把下面两行填进 .env.local（以及 Vercel 的环境变量），第二行不是密钥，可以公开：');
console.log(`SUPABASE_MEDIA_BUCKET=${BUCKET}`);
console.log(`NEXT_PUBLIC_MEDIA_PUBLIC_BASE=${base}/storage/v1/object/public/${BUCKET}`);

if (!process.argv.includes('--verify')) {
  console.log('（加 --verify 会真的传一个 1KB 探针文件跑完整自检，跑完自动删除）');
  process.exit(0);
}

// ===== 2. 实测清单 =====
// 探针放在 u0/：真实用户从 1 开始，所以 u0 永远不会和任何 deck 撞车
const bytes = Buffer.concat([
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
  randomBytes(952),
]);
const sha = createHash('sha256').update(bytes).digest('hex');
const path = `u0/${sha}.png`;

/** 签名地址的真实形态：{url:"/object/upload/sign/{bucket}/{path}?token={jwt}"} */
async function sign(target) {
  const r = await call('申请签名', 'POST', `/storage/v1/object/upload/sign/${BUCKET}/${target}`, {
    headers: secretHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ bucket_id: BUCKET }),
  });
  const rel = JSON.parse(r.text || '{}').url;
  if (!rel) return null;
  const u = new URL(base + '/storage/v1' + rel);
  return { url: u.toString(), token: u.searchParams.get('token') ?? '' };
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

await call('清理残留探针', 'DELETE', `/storage/v1/object/${BUCKET}/${path}`, { soft: true });

const link = await sign(path);
check('服务端能签出上传地址', !!link, link ? link.url.slice(0, 60) + '…' : '没有拿到 url');
if (!link) {
  console.log('\n签不出上传地址，后面的检查没有意义。检查 SUPABASE_SECRET_KEY 是否是这个项目的 secret key。');
  process.exit(1);
}

// 浏览器视角：只有 token，不带任何 apikey
const put = await fetch(link.url, {
  method: 'PUT',
  headers: { Authorization: `Bearer ${link.token}`, 'content-type': 'image/png', 'x-upsert': 'false' },
  body: bytes,
});
check('浏览器只凭 token 就能 PUT（不带 secret key）', put.ok, `HTTP ${put.status}`);

// 关键：完全没有请求头的公开读，就是 <img src> 打出去的样子
const pub = await fetch(`${base}/storage/v1/object/public/${BUCKET}/${path}`);
const got = Buffer.from(await pub.arrayBuffer());
check('无任何 apikey 的公开读返回原字节（<img src> 可用）', pub.ok && Buffer.compare(got, bytes) === 0, `HTTP ${pub.status} ${got.length}B`);

// 重复内容不该再传一次：已存在的键在签发阶段就被拒，这就是去重信号
const dup = await sign(path);
check('同内容重复上传在签发阶段就报「已存在」', dup === null);

// 匿名不能自己签发，否则签名路由就没有意义了
const anonSign = await fetch(`${base}/storage/v1/object/upload/sign/${BUCKET}/u99/${'a'.repeat(64)}.png`, {
  method: 'POST',
  headers: { apikey: anon, Authorization: `Bearer ${anon}`, 'content-type': 'application/json' },
  body: JSON.stringify({ bucket_id: BUCKET }),
});
check('公开 key 签不出上传地址（必须走我们自己的登录态路由）', !anonSign.ok, `HTTP ${anonSign.status}`);

// 匿名列目录必须是空的，否则别人能枚举出这个桶里有什么
const listed = await fetch(`${base}/storage/v1/object/list/${BUCKET}`, {
  method: 'POST',
  headers: { apikey: anon, Authorization: `Bearer ${anon}`, 'content-type': 'application/json' },
  body: JSON.stringify({ prefix: 'u0/', limit: 10 }),
});
const rows = listed.ok ? (await listed.json()) : null;
check('匿名列目录列不出东西', Array.isArray(rows) && rows.length === 0, listed.ok ? JSON.stringify(rows).slice(0, 60) : `HTTP ${listed.status}`);

// 桶层挡非媒体文件：即使签发成功，PUT 也必须被 415 拒掉
const txtLink = await sign(`u0/${'c'.repeat(64)}.png`);
if (txtLink) {
  const bad = await fetch(txtLink.url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${txtLink.token}`, 'content-type': 'text/html', 'x-upsert': 'false' },
    body: Buffer.from('<script>alert(1)</script>'),
  });
  check('非媒体 content-type 被桶拒收', !bad.ok, `HTTP ${bad.status}`);
}

const del = await call('删除探针', 'DELETE', `/storage/v1/object/${BUCKET}/${path}`, {});
check('服务端能删掉对象（将来清理孤儿文件用得上）', del.status === 200, `HTTP ${del.status}`);
await call('删除探针2', 'DELETE', `/storage/v1/object/${BUCKET}/u0/${'c'.repeat(64)}.png`, { soft: true });

finish();

function finish() {
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.name).join('、'));
    process.exit(1);
  }
}
