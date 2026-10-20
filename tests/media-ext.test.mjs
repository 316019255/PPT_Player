import test from 'node:test';
import assert from 'node:assert/strict';

import { extForMime, extForMimeOfKind, maxUploadBytesFor, mimeForExt, ruleForMime, sniffImageMime, sniffMediaMime, sniffVideoMime, storedImageExt, storedVideoExt } from '../src/lib/media-ext.ts';

/**
 * 拼一个文件头：字符串按 ASCII 原样放，数组按字节放，并自动补到 16 字节。
 * 补长度是必要的——嗅探对不足 12 字节的输入一律说「认不出」，
 * 手搓的短 fixture 会让「不该认出」的用例因为长度而不是因为内容通过。
 */
function head(...parts) {
  const bytes = parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p));
  while (bytes.length < 16) bytes.push(0);
  return Uint8Array.from(bytes);
}

test('六种位图的魔数都认得出来', () => {
  assert.equal(sniffImageMime(head([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
  assert.equal(sniffImageMime(head([0xff, 0xd8, 0xff, 0xe0], 'JFIF')), 'image/jpeg');
  assert.equal(sniffImageMime(head('GIF89a')), 'image/gif');
  assert.equal(sniffImageMime(head('GIF87a')), 'image/gif', '老版 GIF 也是图片');
  assert.equal(sniffImageMime(head('RIFF', [0, 0, 0, 0], 'WEBP')), 'image/webp');
  assert.equal(sniffImageMime(head('BM')), 'image/bmp');
  assert.equal(sniffImageMime(head([0, 0, 0, 0x18], 'ftyp', 'avif')), 'image/avif');
  assert.equal(sniffImageMime(head([0, 0, 0, 0x18], 'ftyp', 'avis')), 'image/avif');
});

test('认不出来就是没有，绝不猜成图片', () => {
  assert.equal(sniffImageMime(head('<svg xmlns=', 'http')), null, 'svg 会从站点自身源执行脚本');
  assert.equal(sniffImageMime(head('<!DOCTYPE html', 'x')), null);
  assert.equal(sniffImageMime(head('%PDF-1.4')), null);
  assert.equal(sniffImageMime(head('RIFF', [0, 0, 0, 0], 'AVI ')), null, '同样是 RIFF 容器，不是 WEBP 就不算');
  assert.equal(sniffImageMime(head([0, 0, 0, 0x18], 'ftyp', 'mif1')), null, 'heif 的容器不在白名单里');
  assert.equal(sniffImageMime(head([0x89], 'PNX')), null, '第 2~4 字节差一个就不是 PNG');
  assert.equal(sniffImageMime(head([0xff, 0xd8, 0xf0])), null, 'JPEG 第三字节不对就不是 JPEG');
});

test('字节太少不做判断', () => {
  assert.equal(sniffImageMime(Uint8Array.from([0x89, 0x50, 0x4e, 0x47])), null, '看着像 PNG 头但不足 12 字节');
  assert.equal(sniffImageMime(new Uint8Array(0)), null);
});

test('嗅探交出来的媒体类型，一定都能换成规范后缀', () => {
  // 两张清单必须咬合：sniffImageMime 认出的类型如果换不出后缀，上传会在半路失败
  const detected = [
    head([0x89], 'PNG'),
    head([0xff, 0xd8, 0xff]),
    head('GIF89a'),
    head('RIFF', [0, 0, 0, 0], 'WEBP'),
    head('BM'),
    head([0, 0, 0, 0x18], 'ftyp', 'avif'),
  ];
  for (const h of detected) {
    const mime = sniffImageMime(h);
    assert.ok(mime, '这一步不该丢类型');
    assert.ok(extForMime(mime), `${mime} 换不出后缀`);
  }
});

test('后缀只认清单里的，svg/emf/无后缀都拒', () => {
  assert.equal(storedImageExt('/x/y/image1.png'), '.png');
  assert.equal(storedImageExt('/x/y/image1.JPG'), '.jpg', '大小写归一');
  assert.equal(storedImageExt('/x/y/image1.jpeg'), '.jpg', 'jpeg 一律归到 .jpg，避免同一内容两种后缀');
  assert.equal(storedImageExt('ppt/media/image22.png'), '.png', '包内部件路径同样只看结尾');
  assert.equal(storedImageExt('/x/y/pic.svg'), null);
  assert.equal(storedImageExt('/x/y/pic.emf'), null);
  assert.equal(storedImageExt('/x/y/noext'), null);
});

test('规范后缀能换回媒体类型，未知后缀不给', () => {
  assert.equal(mimeForExt('.jpg'), 'image/jpeg');
  assert.equal(mimeForExt('.PNG'), 'image/png', '大小写归一');
  assert.equal(mimeForExt('.svg'), undefined);
  assert.equal(mimeForExt('.txt'), undefined);
});

test('媒体类型清单只收位图和视频，会自执行的排在门外', () => {
  assert.equal(ruleForMime('image/png')?.ext, '.png');
  assert.equal(ruleForMime('IMAGE/PNG; charset=binary')?.ext, '.png', '大小写与参数都要归一');
  assert.equal(ruleForMime('video/mp4')?.kind, 'video');
  assert.equal(ruleForMime('image/svg+xml'), undefined, 'svg 会从站点自身源执行脚本');
  assert.equal(ruleForMime('text/html'), undefined);
  assert.equal(ruleForMime('application/octet-stream'), undefined);
  assert.equal(ruleForMime(''), undefined);
});

test('视频魔数：ftyp 品牌按种属分流', () => {
  assert.equal(sniffVideoMime(head([0, 0, 0, 0x18], 'ftyp', 'isom')), 'video/mp4');
  assert.equal(sniffVideoMime(head([0, 0, 0, 0x20], 'ftyp', 'mp42')), 'video/mp4');
  assert.equal(sniffVideoMime(head([0, 0, 0, 0x18], 'ftyp', 'qt  ')), 'video/quicktime');
  assert.equal(sniffVideoMime(head([0, 0, 0, 0x18], 'ftyp', 'avc1')), 'video/mp4');
});

test('视频魔数：EBML 认 webm，OggS 认 ogg', () => {
  assert.equal(sniffVideoMime(head([0x1a, 0x45, 0xdf, 0xa3])), 'video/webm');
  assert.equal(sniffVideoMime(head('OggS')), 'video/ogg');
});

test('视频嗅探不认图片，图片嗅探不认视频', () => {
  assert.equal(sniffVideoMime(head([0x89], 'PNG')), null);
  assert.equal(sniffImageMime(head([0, 0, 0, 0x18], 'ftyp', 'isom')), null);
});

test('sniffMediaMime 先图后视频，都能认', () => {
  assert.equal(sniffMediaMime(head([0x89], 'PNG')), 'image/png');
  assert.equal(sniffMediaMime(head([0, 0, 0, 0x18], 'ftyp', 'isom')), 'video/mp4');
  assert.equal(sniffMediaMime(head('RIFF', [0, 0, 0, 0], 'WEBP')), 'image/webp');
  assert.equal(sniffMediaMime(head([0x1a, 0x45, 0xdf, 0xa3])), 'video/webm');
});

test('extForMimeOfKind 按 kind 分流：图片 mime 给视频 kind 返回 null', () => {
  assert.equal(extForMimeOfKind('image/png', 'image'), '.png');
  assert.equal(extForMimeOfKind('image/png', 'video'), null);
  assert.equal(extForMimeOfKind('video/mp4', 'video'), '.mp4');
  assert.equal(extForMimeOfKind('video/mp4', 'image'), null);
});

test('storedVideoExt 只认视频白名单后缀', () => {
  assert.equal(storedVideoExt('/x/y/clip.mp4'), '.mp4');
  assert.equal(storedVideoExt('/x/y/clip.WEBM'), '.webm', '大小写归一');
  assert.equal(storedVideoExt('/x/y/clip.ogg'), '.ogv', '.ogg 归一到 .ogv');
  assert.equal(storedVideoExt('/x/y/clip.mov'), '.mov');
  assert.equal(storedVideoExt('/x/y/clip.png'), null, '图片后缀不算视频');
  assert.equal(storedVideoExt('/x/y/clip.avi'), null, 'avi 不在白名单里');
});

test('maxUploadBytesFor 按 kind 分流：视频比图片大', () => {
  assert.equal(maxUploadBytesFor('image'), 12 * 1024 * 1024);
  assert.equal(maxUploadBytesFor('video'), 48 * 1024 * 1024);
});
