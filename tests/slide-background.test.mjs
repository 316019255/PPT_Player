import test from 'node:test';
import assert from 'node:assert/strict';

import {
  backgroundLayerId,
  isStaticBackground,
  nextVideoSourceUrl,
  videoSourceId,
  videoSourceUrl,
} from '../src/lib/slide-background.ts';

/**
 * 背景片源解析的口径：舞台按它决定「跨页要不要续播」，预热按它决定「下一条拉哪个」。
 * 这一份判错，两边必然漂移 —— 同一条视频被当成两条新的重挂（又回到翻页从头播），
 * 或者预热拿半截桶内路径去发请求。
 */

const BASE = 'https://media.test/storage/v1/object/public/ppt/';
const VIDEO_PATH = `u7/${'f'.repeat(64)}.mp4`;
const IMAGE_PATH = `u7/${'a'.repeat(64)}.png`;
const LINK = 'https://cdn.test/loop.mp4';
const LINK2 = 'https://cdn.test/other.mp4';

const bg = (type, value) => ({ type, value });
const slide = (background) => ({ id: 's', background });

test('三种视频背景形态都认得出身份，身份串就是 deck 里存的那个值', () => {
  process.env.NEXT_PUBLIC_MEDIA_PUBLIC_BASE = BASE;
  assert.equal(videoSourceId(bg('video', LINK)), LINK, '外链的身份就是它自己：同一个地址跨页只留一层');
  assert.equal(videoSourceId(bg('local', 'local:aaaaaaaa-bbbb')), 'local:aaaaaaaa-bbbb');
  assert.equal(videoSourceId(bg('cloud', VIDEO_PATH)), VIDEO_PATH);
});

test('不是视频的背景没有片源身份：那一页不该占住层，也不该被预热', () => {
  process.env.NEXT_PUBLIC_MEDIA_PUBLIC_BASE = BASE;
  assert.equal(videoSourceId(bg('color', '#123456')), null);
  assert.equal(videoSourceId(bg('image', LINK)), null);
  assert.equal(videoSourceId(bg('none', '')), null);
  assert.equal(videoSourceId(undefined), null);
  // 云端桶里那张是图片：后缀就是唯一的类型线索，认成视频会给它挂一个 <video>
  assert.equal(videoSourceId(bg('cloud', IMAGE_PATH)), null);
  // 公开读前缀没配好 → 拼不出地址 → 这一页按静态降级，别留一层永远亮不起来
  process.env.NEXT_PUBLIC_MEDIA_PUBLIC_BASE = '';
  assert.equal(videoSourceId(bg('cloud', VIDEO_PATH)), null);
});

test('地址只在能渲染时才给：本机素材没解析出来就是空串，不是半截 URL', () => {
  process.env.NEXT_PUBLIC_MEDIA_PUBLIC_BASE = BASE;
  assert.equal(videoSourceUrl(bg('video', LINK), null), LINK);
  assert.equal(videoSourceUrl(bg('cloud', VIDEO_PATH), null), `${BASE}${VIDEO_PATH}`);
  assert.equal(videoSourceUrl(bg('local', 'local:aaaaaaaa'), 'blob:https://app/1'), 'blob:https://app/1');
  assert.equal(videoSourceUrl(bg('local', 'local:aaaaaaaa'), null), '', '查库还没回：等，别拿空串去挂 src');
  assert.equal(videoSourceUrl(bg('color', '#000'), null), '');
});

test('连续几页同一条视频：身份相同，所以层不重挂、视频不回 0 秒', () => {
  const a = slide(bg('video', LINK));
  const b = slide(bg('video', LINK));
  assert.equal(videoSourceId(a.background), videoSourceId(b.background), '歌词一页一句是常态：跨页必须认成同一条');
});

test('往后找第一条不同的片源：同一条跳过，中间夹图片页也不打断', () => {
  process.env.NEXT_PUBLIC_MEDIA_PUBLIC_BASE = BASE;
  const pages = [
    slide(bg('video', LINK)),
    slide(bg('video', LINK)),
    slide(bg('color', '#000')),
    slide(bg('image', 'https://cdn.test/x.png')),
    slide(bg('video', LINK2)),
  ];
  assert.equal(nextVideoSourceUrl(pages, 0, LINK), LINK2, '第 2 页还是这一条，不值得热；第 5 页才是新的');
  assert.equal(nextVideoSourceUrl(pages, 4, LINK2), '', '后面没有页了');
});

test('本机素材不预热：blob 地址要异步查库，而那条路径本来就不走网络', () => {
  process.env.NEXT_PUBLIC_MEDIA_PUBLIC_BASE = BASE;
  const pages = [slide(bg('video', LINK)), slide(bg('local', 'local:aaaaaaaa1')), slide(bg('video', LINK2))];
  assert.equal(nextVideoSourceUrl(pages, 0, LINK), LINK2, '跳过本机那一页，继续往后找外链');

  const onlyLocal = [slide(bg('color', '#000')), slide(bg('local', 'local:aaaaaaaa2'))];
  assert.equal(nextVideoSourceUrl(onlyLocal, 0, null), '');
});

test('往后最多看 4 页：整段都是同一条视频时不去替用户下载他翻不到的地方', () => {
  process.env.NEXT_PUBLIC_MEDIA_PUBLIC_BASE = BASE;
  const far = [
    slide(bg('video', LINK)),
    slide(bg('color', '#111')),
    slide(bg('color', '#222')),
    slide(bg('color', '#333')),
    slide(bg('color', '#444')),
    slide(bg('video', LINK2)),
  ];
  assert.equal(nextVideoSourceUrl(far, 0, LINK), '', '第 6 页才换片源：超出窗口，不热');
  assert.equal(nextVideoSourceUrl(far, 1, null), LINK2, '从第 2 页起算，新片源就在窗口内');
});

test('畸形背景不当成片源，也就不会被喂给预热', () => {
  process.env.NEXT_PUBLIC_MEDIA_PUBLIC_BASE = BASE;
  const pages = [
    slide(bg('cloud', '../../etc/passwd')),
    slide(bg('cloud', 'u7/not-hex.mp4')),
    slide(bg('video', '')),
    slide(bg('none', '')),
  ];
  for (const p of pages) assert.equal(videoSourceId(p.background), null);
  assert.equal(nextVideoSourceUrl(pages, -1, null), '');
});

/**
 * 层栈按 backgroundLayerId 决定一层的生死。纯色/图片没有片源身份，
 * 但**必须有层身份**：换到视频页的那一帧旧底色若被撤掉，新层淡入的 0.8 秒底下就是舞台黑底 ——
 * 无头实测抓到过 33/320 个样本整屏没有任何满不透明度层铺满，那就是用户说的「闪一下」。
 */
test('纯色/图片也有层身份：上一页的底色要留在屏幕上给新层垫底', () => {
  process.env.NEXT_PUBLIC_MEDIA_PUBLIC_BASE = BASE;
  assert.equal(backgroundLayerId(bg('color', '#123456')), 'color:#123456');
  assert.equal(backgroundLayerId(bg('image', LINK)), `image:${LINK}`);
  assert.equal(backgroundLayerId(bg('cloud', IMAGE_PATH)), `cloud:${IMAGE_PATH}`);
  // 视频那几支的身份仍是片源串本身：层按它跨页存活，不因为改了口径就变成每页重挂
  assert.equal(backgroundLayerId(bg('video', LINK)), LINK, '视频身份必须还是地址本身，加前缀等于每页重挂');
  assert.equal(backgroundLayerId(bg('local', 'local:aaaaaaaa-bbbb')), 'local:aaaaaaaa-bbbb');
});

test('什么也画不出来的背景没有层身份：那页不许留一层永远亮不起来', () => {
  process.env.NEXT_PUBLIC_MEDIA_PUBLIC_BASE = BASE;
  assert.equal(backgroundLayerId(bg('none', '')), '');
  assert.equal(backgroundLayerId(bg('color', '')), '');
  assert.equal(backgroundLayerId(bg('video', '')), '');
  assert.equal(backgroundLayerId(undefined), '');
});

test('静态背景的判定决定要不要溶解：只有两层都静态才硬切', () => {
  process.env.NEXT_PUBLIC_MEDIA_PUBLIC_BASE = BASE;
  assert.equal(isStaticBackground(bg('color', '#123')), true);
  assert.equal(isStaticBackground(bg('image', LINK)), true);
  assert.equal(isStaticBackground(bg('cloud', IMAGE_PATH)), true, '桶里那张是图片 = 静态');
  assert.equal(isStaticBackground(bg('cloud', VIDEO_PATH)), false, '桶里那条是视频 = 要等首帧');
  assert.equal(isStaticBackground(bg('video', LINK)), false);
  // 本机素材查库前不知道是图是视频，一律按「可能要等」算：不许硬切掉正垫着的上一页
  assert.equal(isStaticBackground(bg('local', 'local:aaaaaaaa-bbbb')), false);
  assert.equal(isStaticBackground(undefined), false);
});
