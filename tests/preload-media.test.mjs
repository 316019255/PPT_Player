import test from 'node:test';
import assert from 'node:assert/strict';

import { preloadSlideMedia } from '../src/lib/preload-media.ts';

/**
 * 覆盖 B6 的预热取舍：哪些字节该提前要、哪些绝对不该。
 *
 * 假 Image 只记下被赋过 src 的地址，等于「浏览器会为此发一个请求」。
 * 这里能证明的是发不发、发几次；「请求在翻页之前就到位」得看真放映页，
 * 那一段由浏览器实测补。
 * warmed 表是模块级的，一次进程只认一遍，所以每个用例用各自不重样的地址。
 */

const asked = [];

globalThis.Image = class {
  set src(value) {
    asked.push(value);
  }
};

const slide = (background, imageBlocks = [], videoBlocks = []) => ({
  id: 's1',
  background,
  textBlocks: [],
  imageBlocks,
  videoBlocks,
});

const img = (kind, value) => ({ id: 'b1', src: { kind, value }, x: 0, y: 0, width: 10, height: 10 });
const vid = (kind, value) => ({ id: 'v1', src: { kind, value }, x: 0, y: 0, width: 10, height: 10 });
const remote = (name) => `https://cdn.test/${name}`;
const BASE = 'https://media.test/storage/v1/object/public/ppt/';

test('只热图片：视频块和本机素材一个请求都不发', () => {
  process.env.NEXT_PUBLIC_MEDIA_PUBLIC_BASE = BASE;
  asked.length = 0;

  preloadSlideMedia(
    slide(
      { type: 'local', value: 'local:aaaaaaaa-bbbb' },
      [img('remote', remote('want-a.png')), img('local', 'local:cccccccc-dddd')],
      [vid('remote', remote('skip-me.mp4')), vid('cloud', 'u7/00000000000000000000000000000000000000000000000000000000000000aa.mp4')]
    )
  );

  assert.deepEqual(asked, [remote('want-a.png')], '只有那张外链图片值得提前；视频和本地图都不该碰');
});

test('云端桶路径要先拼出公开读域名，图片块和 picture 背景都算', () => {
  process.env.NEXT_PUBLIC_MEDIA_PUBLIC_BASE = BASE;
  asked.length = 0;
  const path = 'u7/111111111111111111111111111111111111111111111111111111111111111b.png';

  preloadSlideMedia(slide({ type: 'cloud', value: path }, [img('cloud', path)]));

  assert.deepEqual(asked, [BASE + path], '背景和图块指同一个对象：拼成完整域名，但只发一次');
});

test('同一个地址一次会话只热一回，来回翻页不会变成重复请求', () => {
  process.env.NEXT_PUBLIC_MEDIA_PUBLIC_BASE = BASE;
  asked.length = 0;
  const one = slide({ type: 'none', value: '' }, [img('remote', remote('twice.png'))]);

  preloadSlideMedia(one);
  preloadSlideMedia(one);
  preloadSlideMedia(slide({ type: 'image', value: remote('twice.png') }));

  assert.equal(asked.length, 1, `实际发了 ${asked.length} 次`);
});

test('畸形值一个请求都不发：拼不出半截 URL，也不替 deck 打开任意地址的门', () => {
  process.env.NEXT_PUBLIC_MEDIA_PUBLIC_BASE = BASE;
  asked.length = 0;

  preloadSlideMedia(
    slide(
      { type: 'image', value: 'javascript:alert(1)' },
      [
        img('remote', 'data:image/png;base64,AAAA'),
        img('remote', '//evil.test/x.png'),
        img('remote', 'file:///c:/windows/win.ini'),
        img('remote', 'http://insecure.test/x.png'),
        img('cloud', '../../etc/passwd'),
        img('remote', 'C:\\pics\\a.png'),
      ]
    )
  );

  assert.deepEqual(asked, [], '非法来源宁可少热一张图，也不发一个请求');
});

test('站内绝对路径也预热；公开读前缀没配好时云端一块都不发', () => {
  asked.length = 0;
  process.env.NEXT_PUBLIC_MEDIA_PUBLIC_BASE = '';
  preloadSlideMedia(slide({ type: 'cloud', value: 'u7/222222222222222222222222222222222222222222222222222222222222222c.png' }, [img('remote', '/uploads/local-copy.png')]));
  assert.deepEqual(asked, ['/uploads/local-copy.png'], '没配前缀就当没有这张云端图，别拿桶内路径去发本站请求');

  process.env.NEXT_PUBLIC_MEDIA_PUBLIC_BASE = 'http://not-https.test';
  asked.length = 0;
  preloadSlideMedia(slide({ type: 'none', value: '' }, [img('cloud', 'u7/333333333333333333333333333333333333333333333333333333333333333d.png')]));
  assert.deepEqual(asked, [], '非 https 的前缀同样不算配好');
});
