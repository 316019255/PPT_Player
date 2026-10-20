import test from 'node:test';
import assert from 'node:assert/strict';

import { readUploadRequest } from '../src/lib/upload-request.ts';

const SHA = 'f21c8df9' + '0'.repeat(56);
const OK = { sha256: SHA, mime: 'image/png', size: 4096 };

test('形状判定只认指纹、媒体类型、大小三项，返回值带着服务端推出来的后缀', () => {
  assert.deepEqual(readUploadRequest(OK), { ok: true, sha256: SHA, mime: 'image/png', size: 4096, kind: 'image', ext: '.png' });
  assert.equal(readUploadRequest({ ...OK, mime: 'image/jpeg' }).ext, '.jpg', 'jpeg 归到 .jpg，桶键才不会有两种写法');
  assert.equal(readUploadRequest({ ...OK, mime: 'IMAGE/JPEG' }).ext, '.jpg', '大小写和分号后面的东西不影响判定');
  assert.equal(readUploadRequest({ ...OK, mime: 'image/jpeg;charset=binary' }).ext, '.jpg');
  assert.equal(readUploadRequest({ ...OK, mime: 'video/ogg' }).ext, '.ogv', 'ogg 视频按 .ogv 存');
  assert.equal(readUploadRequest({ ...OK, mime: 'video/mp4', size: 1 }).kind, 'video');
});

test('请求里带的 ext / path / userId 一概不采信', () => {
  // 后缀必须由 mime 反推：否则 x.png 里塞 html、或者把字节塞进别人的目录都成了请求方说了算
  const r = readUploadRequest({ ...OK, ext: '.svg', path: `u8/${SHA}.svg`, userId: 8, kind: 'video' });
  assert.equal(r.ok, true);
  assert.equal(r.ext, '.png');
  assert.equal(r.kind, 'image');
  assert.equal('path' in r, false);
  assert.equal('userId' in r, false);
});

test('指纹、类型、大小任何一项不对就是 400，超限是 413', () => {
  const bad = [
    [null, '请求体为 null'],
    [[], '数组没有属性可取'],
    ['abc', '字符串同理会炸'],
    [42, '数字更不是对象'],
    [{ ...OK, sha256: undefined }, '缺指纹'],
    [{ ...OK, sha256: SHA.slice(0, 63) }, '指纹少一位'],
    [{ ...OK, sha256: SHA.toUpperCase() }, '大写十六进制不收：桶键按小写存'],
    [{ ...OK, sha256: 'x'.repeat(64) }, '不是十六进制'],
    [{ ...OK, sha256: `../${SHA}` }, '指纹里带不进路径'],
    [{ ...OK, mime: undefined }, '缺媒体类型'],
    [{ ...OK, mime: 'image/svg+xml' }, 'svg 会从站点自身源执行脚本'],
    [{ ...OK, mime: 'text/html' }, '不是位图也不是视频'],
    [{ ...OK, mime: 1 }, '类型不是字符串'],
    [{ ...OK, size: 0 }, '空文件'],
    [{ ...OK, size: -1 }, '负数'],
    [{ ...OK, size: 1.5 }, '不是整数'],
    [{ ...OK, size: '4096' }, '字符串大小不采信'],
    [{ ...OK, size: NaN }, 'NaN'],
    [{ ...OK, size: Infinity }, 'Infinity'],
  ];
  for (const [body, why] of bad) {
    const r = readUploadRequest(body);
    assert.equal(r.ok, false, `${why}：不该过`);
    assert.equal(r.status, 400, `${why}：调用方的错要是 400`);
    assert.equal(typeof r.error, 'string');
    assert.ok(r.error.length > 0, `${why}：得有一句能显示给人看的原因`);
  }
});

test('超过单文件大小上限是 413，文案带上是哪一种和上限是多少', () => {
  const img = readUploadRequest({ ...OK, size: 12 * 1024 * 1024 + 1 });
  assert.equal(img.ok, false);
  assert.equal(img.status, 413);
  assert.match(img.error, /图片/);
  assert.match(img.error, /12MB/);

  const vid = readUploadRequest({ ...OK, mime: 'video/mp4', size: 48 * 1024 * 1024 + 1 });
  assert.equal(vid.status, 413);
  assert.match(vid.error, /视频/);
  assert.match(vid.error, /48MB/);

  // 上限本身要给过：边界差一字节就会把正常的课件图全挡在门外
  assert.equal(readUploadRequest({ ...OK, size: 12 * 1024 * 1024 }).ok, true);
  assert.equal(readUploadRequest({ ...OK, mime: 'video/mp4', size: 48 * 1024 * 1024 }).ok, true);
});
