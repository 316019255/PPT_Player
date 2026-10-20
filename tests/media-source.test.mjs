import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cloudPath,
  cloudPublicUrl,
  hasMediaBase,
  isCloudPath,
  isLibraryCloudPath,
  libraryCloudPath,
  localValue,
  parseCloudAnyValue,
  parseCloudValue,
  parseCloudVideoValue,
  parseLocalValue,
  parseRemoteUrl,
} from '../src/lib/media-source.ts';
import { extForMime } from '../src/lib/media-ext.ts';

const SHA = 'f21c86cc742169e0d2f6ad29cfff6a066081852a9ca35bb29085ee70147f2c15';
const KEY = '11e21454-0bd9-437f-b4f4-488493ce6f7c';

test('上传能产生的每一种后缀，路径这一头都必须认', () => {
  // 两张清单必须同尺寸：能签发上传的后缀如果过不了 CLOUD_PATH，这张图传上去也显示不出来
  for (const mime of ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/avif']) {
    const ext = extForMime(mime);
    assert.ok(ext, `${mime} 应该能换出后缀`);
    assert.notEqual(cloudPath(7, SHA, ext), '', `${ext} 被路径规则拒了`);
  }
});

test('桶内路径由唯一那个拼法生成，deck 里存的和桶里的键是同一个字符串', () => {
  const path = cloudPath(7, SHA, '.png');
  assert.equal(path, `u7/${SHA}.png`);
  assert.equal(parseCloudValue(path), path, '拼出来的必须过自己的校验');
});

test('指纹、后缀、目录任何一段形状不对，就不给路径', () => {
  assert.equal(cloudPath(7, SHA.toUpperCase(), '.png'), '', '大写十六进制不收：桶键按小写存');
  assert.equal(cloudPath(7, SHA.slice(0, 63), '.png'), '', '少一位');
  assert.equal(cloudPath(7, `${SHA}0`, '.png'), '', '多一位');
  assert.equal(cloudPath(7, `${SHA.slice(0, 63)}g`, '.png'), '', '不是十六进制');
  assert.equal(cloudPath(7, SHA, '.svg'), '', 'svg 会从站点自身源执行脚本');
  assert.equal(cloudPath(7, SHA, '.jpeg'), '', 'jpeg 一律归到 .jpg，同一个内容不该有两种键');
  assert.equal(cloudPath(7, SHA, '.txt'), '', '只收位图后缀');
  assert.equal(cloudPath(7, SHA, 'png'), '', '缺点');
  assert.equal(cloudPath(7, SHA, ''), '', '缺后缀等于没有形状');
  assert.equal(cloudPath(7, SHA, `.x${SHA}`), '', '后缀超长也不能蒙过去');
});

test('路径里带不进任何越权形状', () => {
  // userId 来自登录态，但指纹和后缀来自请求，所以这两段必须拼不出 ../ 、? # 之类的东西
  assert.equal(cloudPath(7, '../../etc/passwd', '.png'), '');
  assert.equal(cloudPath(7, SHA, '.png?x=1'), '');
  assert.equal(cloudPath(7, SHA, '.png#f'), '');
  assert.equal(cloudPath(7, SHA, '.png/'), '');
  assert.equal(cloudPath(7, SHA, '.png .png'), '');
});

test('没配公开读前缀时，一个云端地址都不拼', () => {
  const saved = process.env.NEXT_PUBLIC_MEDIA_PUBLIC_BASE;
  const path = cloudPath(7, SHA, '.png');
  try {
    delete process.env.NEXT_PUBLIC_MEDIA_PUBLIC_BASE;
    assert.equal(hasMediaBase(), false);
    assert.equal(cloudPublicUrl(path), '', '缺配置就按「缺素材」降级，不拼半截 URL 去请求');

    process.env.NEXT_PUBLIC_MEDIA_PUBLIC_BASE = 'http://insecure.example.com/storage';
    assert.equal(hasMediaBase(), false, '明文 http 不算配置好');

    process.env.NEXT_PUBLIC_MEDIA_PUBLIC_BASE = 'https://example.com/a b';
    assert.equal(hasMediaBase(), false, '带空格拼不出可用的 URL');

    process.env.NEXT_PUBLIC_MEDIA_PUBLIC_BASE = 'https://example.com/storage/v1/object/public/slide-media/';
    assert.equal(hasMediaBase(), true);
    assert.equal(cloudPublicUrl(path), `https://example.com/storage/v1/object/public/slide-media/${path}`, '尾部斜杠只留一个');
    assert.equal(cloudPublicUrl(`u7/${SHA.slice(0, 63)}x.png`), '', '不是云端形状的值一律不拼');
    assert.equal(cloudPublicUrl(`u7/../../${SHA}.png`), '');
  } finally {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_MEDIA_PUBLIC_BASE;
    else process.env.NEXT_PUBLIC_MEDIA_PUBLIC_BASE = saved;
  }
});

test('三种来源互斥：本地引用不会被当成 URL，外链不会被剥成路径', () => {
  assert.equal(parseLocalValue(localValue(KEY)), KEY);
  assert.equal(localValue(KEY), `local:${KEY}`);
  assert.equal(parseRemoteUrl(`local:${KEY}`), '', '本地引用绝不能被当作地址使用');
  assert.equal(parseRemoteUrl('https://cdn.example.com/a.png'), 'https://cdn.example.com/a.png');
  assert.equal(parseRemoteUrl('/uploads/a.png'), '/uploads/a.png', '站内绝对路径也算合法地址');
  assert.equal(parseRemoteUrl('//cdn.example.com/a.png'), '', '协议相对写法会跟着页面换协议，拒');
  assert.equal(parseRemoteUrl('data:image/png;base64,AAAA'), '');
  assert.equal(parseRemoteUrl(`u7/${SHA}.png`), '', '桶内路径不是可直接显示的地址');
  assert.equal(parseLocalValue(`u7/${SHA}.png`), '');
});

test('本地引用只认不透明形状，拼不出任何路径', () => {
  assert.equal(parseLocalValue('local:abcd1234'), 'abcd1234');
  assert.equal(parseLocalValue('local:abc'), '', '太短');
  assert.equal(parseLocalValue('local:../../etc'), '', '不能带斜杠和点');
  assert.equal(parseLocalValue('local:ab cd'), '', '不能带空格');
  assert.equal(parseLocalValue('https://example.com/a.png'), '', '不是本地引用');
});

test('cloudPath 同时接受图片和视频后缀', () => {
  assert.notEqual(cloudPath(7, SHA, '.mp4'), '', '视频后缀也该能拼出路径');
  assert.notEqual(cloudPath(7, SHA, '.webm'), '');
  assert.notEqual(cloudPath(7, SHA, '.mov'), '');
  assert.notEqual(cloudPath(7, SHA, '.ogv'), '');
  assert.notEqual(cloudPath(7, SHA, '.png'), '', '图片后缀照常');
});

test('parseCloudVideoValue 只接受视频后缀，图片路径被拒', () => {
  assert.equal(parseCloudVideoValue(`u7/${SHA}.mp4`), `u7/${SHA}.mp4`);
  assert.equal(parseCloudVideoValue(`u7/${SHA}.webm`), `u7/${SHA}.webm`);
  assert.equal(parseCloudVideoValue(`u7/${SHA}.png`), '', '图片路径不该通过视频校验');
  assert.equal(parseCloudVideoValue(`u7/${SHA}.jpg`), '');
});

test('parseCloudValue 只接受图片后缀，视频路径被拒', () => {
  assert.equal(parseCloudValue(`u7/${SHA}.png`), `u7/${SHA}.png`);
  assert.equal(parseCloudValue(`u7/${SHA}.mp4`), '', '视频路径不该通过图片校验');
  assert.equal(parseCloudValue(`u7/${SHA}.webm`), '');
});

test('素材库的对象名：lib/{sha}{ext}，拼完过自己的校验', () => {
  assert.equal(libraryCloudPath(SHA, '.png'), `lib/${SHA}.png`);
  assert.equal(libraryCloudPath(SHA, '.mp4'), `lib/${SHA}.mp4`, '在线背景可以是视频');
  assert.equal(parseCloudAnyValue(libraryCloudPath(SHA, '.mp4')), `lib/${SHA}.mp4`);

  // 和 cloudPath 同一套形状规则：指纹、后缀任何一段歪了都是空串，不是半截路径
  assert.equal(libraryCloudPath(SHA.toUpperCase(), '.png'), '');
  assert.equal(libraryCloudPath(SHA.slice(0, 63), '.png'), '');
  assert.equal(libraryCloudPath(SHA, '.svg'), '');
  assert.equal(libraryCloudPath(SHA, '.jpeg'), '', 'jpeg 一律归到 .jpg');
  assert.equal(libraryCloudPath(SHA, 'png'), '');
  assert.equal(libraryCloudPath(SHA, ''), '');
  assert.equal(libraryCloudPath('../../etc', '.png'), '');
  assert.equal(libraryCloudPath(SHA, '.png?x=1'), '');
});

test('parseCloudAnyValue / isCloudPath：背景用的合并校验', () => {
  assert.equal(parseCloudAnyValue(`u7/${SHA}.png`), `u7/${SHA}.png`);
  assert.equal(parseCloudAnyValue(`lib/${SHA}.mov`), `lib/${SHA}.mov`);
  assert.equal(parseCloudAnyValue(`u7/${SHA}.svg`), '', 'svg 会从站点自身源执行脚本');
  assert.equal(parseCloudAnyValue(`LIB/${SHA}.png`), '', '桶键按小写存');
  assert.equal(parseCloudAnyValue(`lib/../u8/${SHA}.png`), '', '越不到别人的目录');
  assert.equal(parseCloudAnyValue(`https://x.com/lib/${SHA}.png`), '', '域名不进 deck');
  assert.equal(isCloudPath(`lib/${SHA}.png`), true);
  assert.equal(isCloudPath(`local:${KEY}`), false);
  assert.equal(isCloudPath('https://cdn.example.com/a.png'), false);
});

test('isLibraryCloudPath 只放行 lib/ 目录：后台删文件的权限面就锁在这一格', () => {
  assert.equal(isLibraryCloudPath(`lib/${SHA}.mp4`), true);
  assert.equal(isLibraryCloudPath(`u7/${SHA}.png`), false, '用户上传的字节不属于后台');
  assert.equal(isLibraryCloudPath('https://cdn.example.com/a.png'), false, '外链没有桶内文件可删');
  assert.equal(isLibraryCloudPath(`lib/${SHA}.svg`), false);
  assert.equal(isLibraryCloudPath(`lib/../u7/${SHA}.png`), false);
  assert.equal(isLibraryCloudPath('lib/'), false);
});

test('lib/ 路径照样拼得出公开地址，非法形状一个都不拼', () => {
  const saved = process.env.NEXT_PUBLIC_MEDIA_PUBLIC_BASE;
  try {
    process.env.NEXT_PUBLIC_MEDIA_PUBLIC_BASE = 'https://example.com/storage/v1/object/public/slide-media';
    assert.equal(
      cloudPublicUrl(libraryCloudPath(SHA, '.png')),
      `https://example.com/storage/v1/object/public/slide-media/lib/${SHA}.png`
    );
    assert.equal(cloudPublicUrl(`LIB/${SHA}.png`), '');
  } finally {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_MEDIA_PUBLIC_BASE;
    else process.env.NEXT_PUBLIC_MEDIA_PUBLIC_BASE = saved;
  }
});
