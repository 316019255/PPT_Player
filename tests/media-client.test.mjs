import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { sha256Hex, uploadMediaToCloud } from '../src/lib/mediaClient.ts';

/**
 * 路径就是内容指纹，所以浏览器算出来的这一串必须和任何标准实现一致：
 * 对不上的话同一张图会占两个对象，「已经传过了」也永远命中不了。
 * Node 里 crypto.subtle 和浏览器是同一套 WebCrypto，所以这段能真跑。
 */
test('指纹和 Node 的 sha256 实现逐字节一致', async () => {
  for (const input of [new Uint8Array(0), Uint8Array.from([1, 2, 3]), new Uint8Array(4096)]) {
    const hex = await sha256Hex(input);
    assert.equal(hex, createHash('sha256').update(input).digest('hex'));
  }
});

test('交出来的是 64 位小写十六进制，能过路径校验', async () => {
  const hex = await sha256Hex(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]));
  assert.match(hex, /^[0-9a-f]{64}$/, '大写或多一位少一位都会让桶键和 deck 里的值对不上');
});

/** 浏览器直传的三条落点：桶级拒收要说清理由、撞唯一键算成功、去重命中不发字节 */
const PNG_HEAD = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

async function withFetch(handler, run) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body });
    return handler(String(url), init);
  };
  try {
    return { calls, result: await run() };
  } finally {
    globalThis.fetch = real;
  }
}

const json = (status, obj) => ({ ok: status >= 200 && status < 300, status, json: async () => obj, text: async () => JSON.stringify(obj) });

test('PUT 被桶挡回来时，把桶的理由带到提示里', async () => {
  const blob = new Blob([PNG_HEAD]);
  const { result, calls } = await withFetch(
    async (url, init) =>
      init.method === 'POST'
        ? json(200, { path: 'lib/x.png', mime: 'image/png', uploadUrl: 'https://b/storage/v1/object/upload/sign/slide-media/lib/x.png?token=t', token: 'tok' })
        : json(400, { error: 'the mime type of this file is not allowed in this bucket' }),
    () => uploadMediaToCloud(blob, 'image')
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /HTTP 400/);
  assert.match(result.reason, /mime type/, '只报状态码的话，桶配置过期这种事永远查不到根因');
  assert.equal(calls.length, 2);
});

test('桶报「已存在」当成功处理（两个标签页同时传同一份文件）', async () => {
  const blob = new Blob([PNG_HEAD]);
  const { result } = await withFetch(
    async (_url, init) =>
      init.method === 'POST'
        ? json(200, { path: 'lib/x.png', mime: 'image/png', uploadUrl: 'https://b/upload/sign/lib/x.png?token=t', token: 'tok' })
        : json(409, { error: 'KeyAlreadyExists:The resource already exists' }),
    () => uploadMediaToCloud(blob, 'image')
  );
  assert.deepEqual(result, { ok: true, path: 'lib/x.png', reused: true });
});

test('签发阶段就命中去重时，一个字节都不再传', async () => {
  const blob = new Blob([PNG_HEAD]);
  const { result, calls } = await withFetch(
    async () => json(200, { path: 'lib/x.png', mime: 'image/png', reused: true }),
    () => uploadMediaToCloud(blob, 'image')
  );
  assert.deepEqual(result, { ok: true, path: 'lib/x.png', reused: true });
  assert.deepEqual(calls.map((c) => c.method), ['POST'], '多一次 PUT 就是白送的跨海流量');
});
