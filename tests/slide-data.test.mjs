import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_BLOCKS_PER_SLIDE,
  MAX_DATA_BYTES,
  MAX_SLIDES,
  MAX_TEXT_LENGTH,
  parseSlides,
  readStoredSlides,
  serializeSlides,
} from '../src/lib/slide-data.ts';

const slide = (textBlocks = []) => ({ id: 's1', background: { type: 'color', value: '#101020' }, textBlocks });
const block = (patch = {}) => ({
  id: 'b1',
  text: 'hi',
  x: 10,
  y: 10,
  width: 50,
  height: 20,
  fontSize: 24,
  color: '#ffffff',
  fontWeight: 'bold',
  fontStyle: 'italic',
  textAlign: 'center',
  bgColor: '#ff0000',
  bgOpacity: 0.5,
  borderRadius: 8,
  padding: 6,
  borderColor: '#00ff00',
  borderWidth: 2,
  zIndex: 3,
  ...patch,
});

function okSlides(value) {
  const result = parseSlides(value);
  assert.equal(result.ok, true, result.ok ? '' : result.reason);
  return result.slides;
}

test('结构不合法或空演示文稿整体拒绝', () => {
  assert.equal(parseSlides({}).ok, false);
  assert.equal(parseSlides('[]').ok, false);
  assert.equal(parseSlides([]).ok, false, '至少保留一页，否则放映会白屏');
  assert.equal(parseSlides([{ id: 's1' }]).ok, false, '缺少 textBlocks 视为不合法');
  assert.equal(parseSlides(new Array(MAX_SLIDES + 1).fill(slide())).ok, false);
});

test('数字越界被夹回可用范围，非法值回落到默认', () => {
  const [s] = okSlides([slide([block({ x: 999, y: -50, fontSize: 1e9, bgOpacity: 7, zIndex: 0 })])]);
  const b = s.textBlocks[0];
  assert.equal(b.x, 100);
  assert.equal(b.y, 0);
  assert.equal(b.fontSize, 400);
  assert.equal(b.bgOpacity, 1);
  assert.equal(b.zIndex, 1);

  const [s2] = okSlides([slide([block({ x: 'abc', width: 500, height: NaN })])]);
  assert.equal(s2.textBlocks[0].x, 10, '非数字回落到默认值');
  assert.equal(s2.textBlocks[0].width, 90, '100 - x 是宽度上限');
  assert.equal(s2.textBlocks[0].height, 12, 'NaN 回落到默认高度');

  const [s3] = okSlides([slide([block({ width: Infinity })])]);
  assert.equal(s3.textBlocks[0].width, 80, '非有限数同样回落到默认宽度');
});

test('颜色与枚举只接受合法值', () => {
  const [s] = okSlides([
    slide([block({ color: 'javascript:alert(1)', fontWeight: '<script>', textAlign: 'justify', bgColor: '#zzzzzz' })]),
  ]);
  const b = s.textBlocks[0];
  assert.equal(b.color, '#ffffff');
  assert.equal(b.fontWeight, 'normal');
  assert.equal(b.textAlign, 'left');
  assert.equal(b.bgColor, '');
});

test('文本与 id 按长度截断，不整份拒绝', () => {
  const [s] = okSlides([
    slide([block({ id: 'x'.repeat(200), text: 'A'.repeat(MAX_TEXT_LENGTH + 1000) })]),
  ]);
  assert.equal(s.textBlocks[0].id.length, 64);
  assert.equal(s.textBlocks[0].text.length, MAX_TEXT_LENGTH);
});

test('背景类型未知时按纯色处理', () => {
  const [s] = okSlides([{ id: 's1', background: { type: 'svg', value: '<svg/>' }, textBlocks: [] }]);
  assert.equal(s.background.type, 'color');
  assert.equal(s.background.value, '#1a1a2e');
});

test('素材背景只承认 https 与站内绝对路径', () => {
  const kept = okSlides([
    { id: 's1', background: { type: 'image', value: 'https://images.unsplash.com/photo-1?a=w=1920' }, textBlocks: [] },
    { id: 's2', background: { type: 'image', value: '/uploads/up_mv8_0123456789ab.jpg' }, textBlocks: [] },
    { id: 's3', background: { type: 'video', value: '/uploads/up_mv8_0123456789ab.mp4' }, textBlocks: [] },
  ]);
  assert.equal(kept[0].background.type, 'image');
  assert.equal(kept[1].background.value, '/uploads/up_mv8_0123456789ab.jpg');
  assert.equal(kept[2].background.value, '/uploads/up_mv8_0123456789ab.mp4');

  const dropped = okSlides(
    [
      'javascript:alert(1)',
      'data:image/svg+xml,<svg onload=alert(1)>',
      '//evil.com/x.jpg',
      'C:/Users/me/x.jpg',
      '\\\\fileserver\\share\\x.jpg',
      '/uploads/a b.jpg',
      '',
    ].map((value, i) => ({ id: `s${i}`, background: { type: 'image', value }, textBlocks: [] }))
  );
  for (const s of dropped) {
    assert.deepEqual(s.background, { type: 'none', value: '' }, `${s.id} 应该降级为无背景`);
  }
});

test('本地素材只承认闭合字符集的 local:<key>，畸形 token 与类型错配都降级为无背景', () => {
  const key = 'Msi1234AbCdEf0123456789';
  const [s] = okSlides([
    { id: 's1', background: { type: 'local', value: `local:${key}`, name: '太阳 背景.mp4' }, textBlocks: [] },
  ]);
  assert.equal(s.background.type, 'local');
  assert.equal(s.background.value, `local:${key}`);
  assert.equal(s.background.name, '太阳 背景.mp4');

  const mismatch = okSlides([
    { id: 'a', background: { type: 'image', value: `local:${key}` }, textBlocks: [] },
    { id: 'b', background: { type: 'local', value: 'https://evil.com/x.jpg' }, textBlocks: [] },
  ]);
  assert.deepEqual(mismatch[0].background, { type: 'none', value: '' }, 'image 塞 local: 应拒绝');
  assert.deepEqual(mismatch[1].background, { type: 'none', value: '' }, 'local 塞 https 应拒绝');

  const bad = okSlides(
    [
      'local:',
      'local:../../etc/passwd',
      'local:https://evil.com',
      'local:has space',
      'local:has"quote',
      'local:' + 'x'.repeat(70),
      'local:' + 'x'.repeat(7),
    ].map((value, i) => ({ id: `s${i}`, background: { type: 'local', value }, textBlocks: [] }))
  );
  for (const d of bad) {
    assert.deepEqual(d.background, { type: 'none', value: '' }, `${d.id} 非法 local token 应降级`);
  }
});

test('本地素材 name 会被清洗，只随 local 类型保留，并能序列化读回', () => {
  const key = 'Msi1234AbCdEf0123456789';
  const control = String.fromCharCode(0, 10); // NUL + 换行
  const dirty = okSlides([
    { id: 'x', background: { type: 'local', value: `local:${key}`, name: `  含${control}名${'字'.repeat(300)}` }, textBlocks: [] },
  ]);
  const bg = dirty[0].background;
  assert.equal(bg.type, 'local');
  assert.ok(!(bg.name ?? '').includes(control), '控制字符要剥掉');
  assert.ok((bg.name ?? '').length <= 200, `name 应截断到 200，实为 ${(bg.name ?? '').length}`);

  const noName = okSlides([
    { id: 'y', background: { type: 'image', value: 'https://a.com/b.jpg', name: '不该留' }, textBlocks: [] },
  ]);
  assert.equal(noName[0].background.name, undefined, '本机/云端之外的类型不保留 name');

  const stored = serializeSlides([
    { id: 'z', background: { type: 'local', value: `local:${key}`, name: '影片.mp4' }, textBlocks: [] },
  ]);
  assert.equal(stored.ok, true);
  const back = readStoredSlides(JSON.stringify(stored.ok ? stored.slides : []));
  assert.equal(back[0].background.value, `local:${key}`);
  assert.equal(back[0].background.name, '影片.mp4');
});

test('云端背景只承认桶内路径：域名、越界键、非位图后缀、local token 都降级为无背景', () => {
  const good = `u7/${'0'.repeat(64)}.png`;
  const [s] = okSlides([
    { id: 's1', background: { type: 'cloud', value: good, name: '诗歌底图.jpg' }, textBlocks: [] },
  ]);
  assert.equal(s.background.type, 'cloud');
  assert.equal(s.background.value, good);
  assert.equal(s.background.name, '诗歌底图.jpg');

  const bad = okSlides(
    [
      `https://x.com/${good}`, // 域名不进 deck，渲染时才拼
      `u7/${'0'.repeat(64)}.svg`, // 会自执行的类型不在位图白名单里
      `u7/../u8/${'0'.repeat(64)}.png`, // 越不到别人的前缀
      `u7/${'0'.repeat(63)}.png`, // 指纹差一个字符就不是那张图
      `local:Msi1234AbCdEf0123456789`, // 三支来源互斥
    ].map((value, i) => ({ id: `s${i}`, background: { type: 'cloud', value }, textBlocks: [] }))
  );
  for (const d of bad) {
    assert.deepEqual(d.background, { type: 'none', value: '' }, `${d.id} 非法云端路径应降级`);
  }

  const stored = serializeSlides([{ id: 'z', background: { type: 'cloud', value: good }, textBlocks: [] }]);
  assert.equal(stored.ok, true);
  const back = readStoredSlides(JSON.stringify(stored.ok ? stored.slides : []));
  assert.equal(back[0].background.value, good, '存回去要和读进来一字不差');
});

test('背景这一头 u{id}/ 和 lib/ 两个目录都认，视频后缀也认', () => {
  // 管理员素材库的在线背景就是 lib/{sha}{ext}；图片后缀能过而视频后缀过不了的话，
  // 传上去的动态背景会在存盘时被判成「没有背景」，用户看到的是选好了却不动。
  const sha = '0'.repeat(64);
  const accepted = [
    `lib/${sha}.png`,
    `lib/${sha}.mp4`,
    `lib/${sha}.ogv`,
    `u7/${sha}.webm`,
  ];
  const ok = okSlides(accepted.map((value, i) => ({ id: `s${i}`, background: { type: 'cloud', value }, textBlocks: [] })));
  ok.forEach((s, i) => {
    assert.equal(s.background.type, 'cloud', `${accepted[i]} 该是合法云端背景`);
    assert.equal(s.background.value, accepted[i], '路径原样存，不拼域名');
  });

  const rejected = [
    `lib/../u8/${sha}.png`, // 越不到别人的目录
    `LIB/${sha}.png`, // 桶键按小写存
    `lib/${sha.slice(0, 63)}.png`, // 指纹差一位就不是那张图
    `lib/${sha}.svg`, // 会从站点自身源执行脚本
    `lib/${sha}.txt`,
    `other/${sha}.png`,
  ];
  const bad = okSlides(
    rejected.map((value, i) => ({ id: `b${i}`, background: { type: 'cloud', value }, textBlocks: [] }))
  );
  for (const d of bad) {
    assert.deepEqual(d.background, { type: 'none', value: '' }, `${rejected[Number(d.id.slice(1))]} 不该通过`);
  }
});

test('单页文字块数量有硬上限', () => {
  const blocks = new Array(MAX_BLOCKS_PER_SLIDE + 1).fill(block());
  const result = parseSlides([slide(blocks)]);
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, /文字块/);
});

test('序列化把总体积压在上限内', () => {
  const small = serializeSlides([slide([block()])]);
  assert.equal(small.ok, true);
  assert.equal(small.slides.length, 1);

  const fat = new Array(5).fill(slide(new Array(MAX_BLOCKS_PER_SLIDE).fill(block({ text: 'A'.repeat(MAX_TEXT_LENGTH) }))));
  const big = serializeSlides(fat);
  assert.equal(big.ok, false);
  assert.match(big.ok ? '' : big.reason, /演示文稿数据过大/);
  assert.ok(Buffer.byteLength(JSON.stringify(fat), 'utf8') > MAX_DATA_BYTES);
});

test('读取库里已存的脏数据不会抛异常', () => {
  assert.deepEqual(readStoredSlides(''), []);
  assert.deepEqual(readStoredSlides(null), []);
  assert.deepEqual(readStoredSlides('not json'), []);
  assert.deepEqual(readStoredSlides(JSON.stringify({ hack: true })), []);
  assert.equal(readStoredSlides(JSON.stringify([slide([block()])])).length, 1);
});

// ============ 图片块 ============

const HASH = 'a'.repeat(64);
const image = (patch = {}) => ({
  id: 'i1',
  src: { kind: 'remote', value: 'https://cdn.example.com/a.png' },
  x: 10,
  y: 10,
  width: 30,
  height: 20,
  ...patch,
});
const both = (textBlocks, imageBlocks) => ({
  id: 's1',
  background: { type: 'color', value: '#101020' },
  textBlocks,
  imageBlocks,
});

test('老数据没有 imageBlocks 字段，读回来是空数组', () => {
  const [s] = okSlides([slide([block()])]);
  assert.deepEqual(s.imageBlocks, []);
});

test('imageBlocks 存在但不是数组，整篇拒绝', () => {
  const result = parseSlides([both([block()], { nope: true })]);
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, /图片块/);
});

test('三种来源各认自己的形状，非法的只丢这一块', () => {
  const keep = [
    image({ src: { kind: 'local', value: 'local:abcd1234' } }),
    image({ id: 'i2', src: { kind: 'cloud', value: `u7/${HASH}.png` } }),
    image({ id: 'i3', src: { kind: 'remote', value: 'https://cdn.example.com/a.png' } }),
  ];
  const drop = [
    image({ id: 'i4', src: { kind: 'remote', value: 'http://insecure.example.com/a.png' } }),
    image({ id: 'i5', src: { kind: 'cloud', value: `u7/${HASH}z.png` } }),
    image({ id: 'i6', src: { kind: 'cloud', value: `https://x.supabase.co/storage/v1/object/public/b/u7/${HASH}.png` } }),
    image({ id: 'i7', src: { kind: 'cloud', value: `other/${HASH}.png` } }),
    image({ id: 'i8', src: { kind: 'local', value: 'local:../etc/passwd' } }),
    image({ id: 'i9', src: { kind: 'part', value: 'ppt/media/image1.png' } }),
    image({ id: 'i10', src: 'https://cdn.example.com/a.png' }),
    image({ id: 'i11', src: undefined }),
  ];
  const [s] = okSlides([both([block()], [...keep, ...drop])]);
  assert.deepEqual(s.imageBlocks.map((b) => b.id), ['i1', 'i2', 'i3']);
  // 'local:' 前缀丢了就再也查不到 IndexedDB 里的那份文件，必须原样存回去
  assert.deepEqual(s.imageBlocks[0].src, { kind: 'local', value: 'local:abcd1234' });
});

test('图片块几何沿用同一套百分比夹范围，缺省落到默认可见框', () => {
  const defaulted = both([], [image({ x: undefined, y: undefined, width: undefined, height: undefined })]);
  const [a] = okSlides([defaulted]);
  assert.deepEqual(
    { x: a.imageBlocks[0].x, y: a.imageBlocks[0].y, width: a.imageBlocks[0].width, height: a.imageBlocks[0].height },
    { x: 20, y: 20, width: 60, height: 60 }
  );

  const overflow = both([], [image({ x: 999, y: -50, width: 500, height: NaN })]);
  const [b] = okSlides([overflow]);
  const g = b.imageBlocks[0];
  assert.equal(g.x, 100);
  assert.equal(g.y, 0);
  assert.equal(g.width, 0, 'x 顶到边时宽度被夹到剩余空间');
  assert.equal(g.height, 60, 'NaN 回落到默认');
});

test('fit / alt / zIndex 都被收敛过', () => {
  const deck = both([], [image({ fit: 'tiling', alt: 'B'.repeat(300), zIndex: 0 })]);
  const [s] = okSlides([deck]);
  const only = s.imageBlocks[0];
  assert.equal(only.fit, undefined);
  assert.equal(only.alt.length, 200);
  assert.equal(only.zIndex, 1);
});

test('单页上限按「文字块 + 图片块」合计', () => {
  const texts = new Array(60).fill(block());
  const images = new Array(40).fill(image());
  assert.equal(parseSlides([both(texts, images)]).ok, true);

  const over = parseSlides([both(texts, images.concat(image()))]);
  assert.equal(over.ok, false);
  assert.match(over.ok ? '' : over.reason, /100/);
});

test('图片块存进去再读回来，src 一个字节都不变', () => {
  const sources = [
    { kind: 'local', value: 'local:abcd1234' },
    { kind: 'cloud', value: `u7/${HASH}.png` },
    { kind: 'remote', value: 'https://cdn.example.com/a.png' },
  ];
  const stored = serializeSlides([both([], sources.map((src, i) => image({ id: `i${i}`, src })))]);
  assert.equal(stored.ok, true);
  const back = readStoredSlides(JSON.stringify(stored.ok ? stored.slides : []));
  assert.deepEqual(back[0].imageBlocks.map((b) => b.src), sources);
});

// ============ 视频块 ============
const video = (patch = {}) => ({
  id: 'v1',
  src: { kind: 'remote', value: 'https://cdn.example.com/clip.mp4' },
  x: 10,
  y: 10,
  width: 40,
  height: 30,
  ...patch,
});
const full = (textBlocks, imageBlocks, videoBlocks) => ({
  id: 's1',
  background: { type: 'color', value: '#101020' },
  textBlocks,
  imageBlocks,
  videoBlocks,
});

test('老数据没有 videoBlocks 字段，读回来是空数组', () => {
  const [s] = okSlides([both([block()], [])]);
  assert.deepEqual(s.videoBlocks, []);
});

test('videoBlocks 存在但不是数组，整篇拒绝', () => {
  const result = parseSlides([{ id: 's1', background: { type: 'color', value: '#000' }, textBlocks: [], imageBlocks: [], videoBlocks: 'nope' }]);
  assert.equal(result.ok, false);
});

test('视频块三种来源各认自己的形状，非法的只丢这一块', () => {
  const deck = full([], [], [
    video({ id: 'v1', src: { kind: 'remote', value: 'https://cdn.example.com/clip.mp4' } }),
    video({ id: 'v2', src: { kind: 'cloud', value: `u7/${HASH}.mp4` } }),
    video({ id: 'v3', src: { kind: 'local', value: 'local:abcd1234' } }),
    video({ id: 'bad', src: { kind: 'remote', value: 'not a url' } }),
  ]);
  const [s] = okSlides([deck]);
  assert.equal(s.videoBlocks.length, 3, '非法的那块被丢掉，其余保留');
});

test('视频块云端路径只接受视频后缀', () => {
  const deck = full([], [], [
    video({ id: 'v1', src: { kind: 'cloud', value: `u7/${HASH}.mp4` } }),
    video({ id: 'v2', src: { kind: 'cloud', value: `u7/${HASH}.png` } }),
  ]);
  const [s] = okSlides([deck]);
  assert.equal(s.videoBlocks.length, 1, '图片后缀的云端路径不该通过视频校验');
  assert.equal(s.videoBlocks[0].id, 'v1');
});

test('视频块的 loop/muted/controls 按缺省压缩', () => {
  const deck = full([], [], [
    video({ id: 'v1', loop: true, muted: false, controls: true }),
    video({ id: 'v2' }),
  ]);
  const stored = serializeSlides([deck]);
  assert.equal(stored.ok, true);
  const json = stored.ok ? stored.json : '';
  const parsed = JSON.parse(json);
  // loop/controls 只在 true 时存，muted 只在 false 时存
  assert.equal(parsed[0].videoBlocks[0].loop, true);
  assert.equal(parsed[0].videoBlocks[0].muted, false);
  assert.equal(parsed[0].videoBlocks[0].controls, true);
  // 缺省值不存
  assert.equal(parsed[0].videoBlocks[1].loop, undefined);
  assert.equal(parsed[0].videoBlocks[1].muted, undefined);
  assert.equal(parsed[0].videoBlocks[1].controls, undefined);
});

test('单页上限按「文字块 + 图片块 + 视频块」合计', () => {
  const texts = new Array(50).fill(block());
  const images = new Array(30).fill(image());
  const videos = new Array(20).fill(video());
  assert.equal(parseSlides([full(texts, images, videos)]).ok, true);

  const over = parseSlides([full(texts, images, videos.concat(video()))]);
  assert.equal(over.ok, false);
  assert.match(over.ok ? '' : over.reason, /100/);
});

test('视频块存进去再读回来，src 一个字节都不变', () => {
  const sources = [
    { kind: 'local', value: 'local:abcd1234' },
    { kind: 'cloud', value: `u7/${HASH}.mp4` },
    { kind: 'remote', value: 'https://cdn.example.com/clip.mp4' },
  ];
  const stored = serializeSlides([full([], [], sources.map((src, i) => video({ id: `v${i}`, src })))]);
  assert.equal(stored.ok, true);
  const back = readStoredSlides(JSON.stringify(stored.ok ? stored.slides : []));
  assert.deepEqual(back[0].videoBlocks.map((b) => b.src), sources);
});
