import test from 'node:test';
import assert from 'node:assert/strict';

import JSZip from 'jszip';

import { unpackPptx } from '../src/lib/pptx-pack.ts';
import { importPptx } from '../src/lib/pptx-import.ts';
import { MAX_SLIDES, serializeSlides } from '../src/lib/slide-data.ts';

const NS = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
const SLIDE_16_9 = '<p:sldSz cx="12192000" cy="6858000"/>';
const LAYOUT_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout';
const IMAGE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

/** 媒体部件的内容对这两层是透明的（判格式只看后缀，真字节交给 sink），所以填魔数头就够了 */
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]);
const EMF_BYTES = Uint8Array.from([0x01, 0x00, 0x00, 0x00, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

function slideXml({ text = '甲', pics = [['rId2']], bgRel } = {}) {
  const picShapes = pics
    .map(
      ([rel], i) => `<p:pic><p:nvPicPr><p:cNvPr id="${10 + i}" name="pic${i}"/></p:nvPicPr>
        <p:blipFill><a:blip r:embed="${rel}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
        <p:spPr><a:xfrm><a:off x="0" y="2000000"/><a:ext cx="3000000" cy="2000000"/></a:xfrm></p:spPr></p:pic>`
    )
    .join('');
  const bg = bgRel
    ? `<p:bg><p:bgPr><a:blipFill><a:blip r:embed="${bgRel}"/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>`
    : '';
  return `<p:sld ${NS}><p:cSld>${bg}<p:spTree>
    <p:sp><p:nvSpPr><p:cNvPr id="2" name="t"/></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="1200000"/></a:xfrm></p:spPr>
      <p:txBody><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>
    ${picShapes}
  </p:spTree></p:cSld></p:sld>`;
}

function slideRels(images = [['rId2', '../media/image3.png']]) {
  return `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rId1" Type="${LAYOUT_REL}" Target="../slideLayouts/slideLayout7.xml"/>
    ${images.map(([id, target]) => `<Relationship Id="${id}" Type="${IMAGE_REL}" Target="${target}"/>`).join('')}
  </Relationships>`;
}

/** 现场造一个真 zip：这两层要的是「包能不能摊平」，不是 PowerPoint 的兼容性 */
async function makePptx({ slides, media = {}, master = true }) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('ppt/presentation.xml', `<p:presentation ${NS}>${SLIDE_16_9}</p:presentation>`);
  for (const slide of slides) {
    zip.file(`ppt/slides/${slide.name}.xml`, slide.xml);
    if (slide.rels) zip.file(`ppt/slides/_rels/${slide.name}.xml.rels`, slide.rels);
  }
  if (master) {
    zip.file('ppt/slideMasters/slideMaster1.xml', `<p:sldMaster ${NS}><p:cSld><p:spTree/></p:cSld></p:sldMaster>`);
    zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels',
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`);
    zip.file('ppt/theme/theme1.xml', '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements/></a:theme>');
  }
  for (const [path, bytes] of Object.entries(media)) zip.file(path, bytes);
  return await zip.generateAsync({ type: 'uint8array' });
}

/** 真 sink 按字节哈希，每张图各得一个键；这里也用「一个部件一个值」的映射，免得张冠李戴看不出来 */
const CLOUD_VALUES = {
  'ppt/media/image3.png': 'a'.repeat(64),
  'ppt/media/logo.png': 'b'.repeat(64),
};

function fakeResolver({ cloud = true, failParts = [] } = {}) {
  const calls = [];
  const resolveMedia = async (part, bytes) => {
    calls.push({ part, size: bytes.byteLength });
    if (failParts.includes(part)) return { ok: false, reason: '这张太大了' };
    return {
      ok: true,
      src: cloud
        ? { kind: 'cloud', value: `u1/${CLOUD_VALUES[part] ?? 'c'.repeat(64)}.png` }
        : { kind: 'local', value: 'local:Msi1234AbCdEf0123456789' },
    };
  };
  return { calls, resolveMedia };
}

// ===== 解包 =====

test('unpackPptx 按页码排序取幻灯片，版式/母版/主题与所有关系表都收进 parts', async () => {
  const data = await makePptx({
    slides: [
      { name: 'slide10', xml: slideXml({ text: '十' }), rels: slideRels() },
      { name: 'slide2', xml: slideXml({ text: '二' }), rels: slideRels([['rId2', '../media/image2.png']]) },
    ],
    media: { 'ppt/media/image2.png': PNG_BYTES, 'ppt/media/image3.png': PNG_BYTES },
  });
  const pack = await unpackPptx(data);

  assert.deepEqual(pack.sources.map((s) => s.path), ['ppt/slides/slide2.xml', 'ppt/slides/slide10.xml']);
  assert.equal(pack.slideCount, 2);
  assert.equal(pack.truncated, false);
  assert.match(pack.presentationXml ?? '', /p:sldSz/);
  assert.deepEqual(Object.keys(pack.parts).sort(), [
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    'ppt/slideMasters/slideMaster1.xml',
    'ppt/slides/_rels/slide10.xml.rels',
    'ppt/slides/_rels/slide2.xml.rels',
    'ppt/theme/theme1.xml',
  ]);
  assert.ok(pack.sources[0].xml.includes('二'), '幻灯片 xml 走 sources，不重复进 parts');
});

test('unpackPptx 只按 ppt/media 取字节，别的部件和不存在的路径都给 null', async () => {
  const data = await makePptx({
    slides: [{ name: 'slide1', xml: slideXml(), rels: slideRels() }],
    media: { 'ppt/media/image3.png': PNG_BYTES },
  });
  const pack = await unpackPptx(data);

  assert.deepEqual(await pack.readMedia('ppt/media/image3.png'), PNG_BYTES);
  assert.equal(await pack.readMedia('ppt/slides/slide1.xml'), null, '不是媒体部件就不该给字节');
  assert.equal(await pack.readMedia('ppt/media/../../[Content_Types].xml'), null, '拼出来的相对路径也不给');
  assert.equal(await pack.readMedia('ppt/media/missing.png'), null);
});

test('unpackPptx 对没有幻灯片的包和超过上限的页数都有明确说法', async () => {
  const empty = await makePptx({ slides: [] });
  await assert.rejects(() => unpackPptx(empty), /没有任何幻灯片/);

  const many = Array.from({ length: MAX_SLIDES + 2 }, (_, i) => ({ name: `slide${i + 1}`, xml: slideXml({ text: `第${i + 1}页` }) }));
  const pack = await unpackPptx(await makePptx({ slides: many }));
  assert.equal(pack.slideCount, MAX_SLIDES + 2);
  assert.equal(pack.truncated, true);
  assert.equal(pack.sources.length, MAX_SLIDES);
});

// ===== 编排：字节去向由注入的 resolver 决定 =====

test('importPptx 把正文图填成图片块、整页背景换成云端背景，同一张图只交给 resolver 一次', async () => {
  const shared = slideRels([
    ['rId2', '../media/image3.png'],
    ['rId3', '../media/logo.png'],
  ]);
  const data = await makePptx({
    slides: [
      { name: 'slide1', xml: slideXml({ text: '第一页', bgRel: 'rId3' }), rels: shared },
      { name: 'slide2', xml: slideXml({ text: '第二页' }), rels: shared },
    ],
    media: { 'ppt/media/image3.png': PNG_BYTES, 'ppt/media/logo.png': PNG_BYTES },
  });
  const sink = fakeResolver();
  const progress = [];
  const out = await importPptx({ data, resolveMedia: sink.resolveMedia, onProgress: (p) => progress.push(p) });

  assert.deepEqual(sink.calls.map((c) => c.part).sort(), ['ppt/media/image3.png', 'ppt/media/logo.png']);
  assert.equal(out.images.placed, 2, '两页各一张正文图');
  assert.equal(out.images.backgrounds, 1);
  assert.equal(out.images.dropped, 0);

  const [first, second] = out.slides;
  assert.deepEqual(first.background, { type: 'cloud', value: `u1/${'b'.repeat(64)}.png` });
  assert.equal(first.imageBlocks.length, 1, '整页底图不重复进正文，另一张正文图照旧在');
  assert.equal(first.imageBlocks[0].src.value, `u1/${'a'.repeat(64)}.png`);
  assert.equal(second.background.type, 'color', '这页本来就没写 p:bg，不该被凭空换底');
  assert.equal(second.imageBlocks.length, 1);

  const block = second.imageBlocks[0];
  assert.equal(block.src.kind, 'cloud');
  assert.equal(block.src.value, first.imageBlocks[0].src.value, '同一部件两页共用同一个键，不重复上传');
  assert.equal(block.fit, 'fill');
  assert.equal(block.alt, 'image3.png', '没写 descr 就用包内文件名辨认');
  assert.equal(block.zIndex, 2, '排在同页文字块之后');
  assert.ok(Math.abs(block.y - 29.1631) < 0.01, `y 应为百分比：${block.y}`);

  // 拼出来的 deck 必须直接过服务端的序列化校验
  const stored = serializeSlides(out.slides);
  assert.equal(stored.ok, true, stored.ok ? '' : stored.reason);

  assert.deepEqual(progress.filter((p) => p.phase === 'media').map((p) => `${p.done}/${p.total}`), ['1/2', '2/2']);
});

test('取消勾选时来源是本机库，背景就落成本地引用，仍然合法', async () => {
  const data = await makePptx({
    slides: [{ name: 'slide1', xml: slideXml({ text: '甲', pics: [] , bgRel: 'rId2' }), rels: slideRels() }],
    media: { 'ppt/media/image3.png': PNG_BYTES },
  });
  const out = await importPptx({ data, resolveMedia: fakeResolver({ cloud: false }).resolveMedia });

  assert.deepEqual(out.slides[0].background, { type: 'local', value: 'local:Msi1234AbCdEf0123456789' });
});

test('emf/wmf 这类画不出来的后缀根本不读字节，也不算 resolver 的失败', async () => {
  const rels = slideRels([
    ['rId2', '../media/vector.emf'],
    ['rId3', '../media/image3.png'],
  ]);
  const data = await makePptx({
    slides: [{ name: 'slide1', xml: slideXml({ pics: [['rId2'], ['rId3']] }), rels }],
    media: { 'ppt/media/vector.emf': EMF_BYTES, 'ppt/media/image3.png': PNG_BYTES },
  });
  const sink = fakeResolver();
  const out = await importPptx({ data, resolveMedia: sink.resolveMedia });

  assert.deepEqual(sink.calls.map((c) => c.part), ['ppt/media/image3.png'], 'emf 不该被送去存，也不该占一次上传');
  assert.equal(out.slides[0].imageBlocks.length, 1);
  assert.equal(out.images.dropped, 1);
  assert.match(out.warnings.join('\n'), /1 张图片没能带进来：这种格式浏览器画不出来/);
});

test('某一张存失败只丢那一张，背景失败额外说明这页退回纯色底', async () => {
  const rels = slideRels([
    ['rId2', '../media/image3.png'],
    ['rId3', '../media/logo.png'],
  ]);
  const data = await makePptx({
    slides: [
      { name: 'slide1', xml: slideXml({ bgRel: 'rId3', pics: [['rId2']] }), rels },
      { name: 'slide2', xml: slideXml({ pics: [['rId3']] }), rels },
    ],
    media: { 'ppt/media/image3.png': PNG_BYTES, 'ppt/media/logo.png': PNG_BYTES },
  });
  const sink = fakeResolver({ failParts: ['ppt/media/logo.png'] });
  const out = await importPptx({ data, resolveMedia: sink.resolveMedia });

  assert.equal(out.slides[0].background.type, 'color', '背景那张失败 → 保持纯色兜底');
  assert.equal(out.slides[1].imageBlocks.length, 0);
  assert.equal(out.slides[0].imageBlocks.length, 1);
  const warnings = out.warnings.join('\n');
  assert.match(warnings, /1 张图片没能带进来：这张太大了/);
  assert.match(warnings, /1 页的图片背景没能带进来，这些页用的是纯色底/);
});

test('单页元素超上限时先丢装饰色块、再丢图片，正文文字留到最后', async () => {
  const pics = Array.from({ length: 5 }, (_, i) => [`rId${2 + i}`, `../media/p${i}.png`]);
  const blocks = Array.from(
    { length: 98 },
    (_, i) => `<p:sp><p:nvSpPr><p:cNvPr id="${20 + i}" name="t${i}"/></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="200000"/></a:xfrm></p:spPr>
      <p:txBody><a:bodyPr/><a:p><a:r><a:t>第${i}行</a:t></a:r></a:p></p:txBody></p:sp>`
  ).join('');
  const shapes = pics
    .map(
      ([rel], i) => `<p:pic><p:nvPicPr><p:cNvPr id="${200 + i}" name="p${i}"/></p:nvPicPr>
        <p:blipFill><a:blip r:embed="${rel}"/></p:blipFill>
        <p:spPr><a:xfrm><a:off x="0" y="3000000"/><a:ext cx="1000000" cy="500000"/></a:xfrm></p:spPr></p:pic>`
    )
    .join('');
  const xml = `<p:sld ${NS}><p:cSld><p:spTree>${blocks}${shapes}</p:spTree></p:cSld></p:sld>`;
  const data = await makePptx({
    slides: [{ name: 'slide1', xml, rels: slideRels([['rId1x', '../slideLayouts/slideLayout7.xml'], ...pics.map(([rel, t]) => [rel, t])]) }],
    media: Object.fromEntries(pics.map(([, t]) => [`ppt/${t.replace('../', '')}`, PNG_BYTES])),
    master: false,
  });
  const out = await importPptx({ data, resolveMedia: fakeResolver().resolveMedia });
  const slide = out.slides[0];

  assert.equal(slide.textBlocks.length, 98, '正文一个字都不该丢');
  assert.equal(slide.imageBlocks.length, 2, `98 + 5 张超了 100，只该留 2 张：${slide.imageBlocks.length}`);
  assert.match(out.warnings.join('\n'), /单页最多 100 个元素（文字 \+ 图片），共丢弃 0 个装饰色块、3 张图片、0 个文字块/);
  assert.equal(serializeSlides(out.slides).ok, true);
});

test('估算就超过 2MB 时，在动任何一张图之前就停手', async () => {
  const long = '字'.repeat(4000);
  const slide = (n) => `<p:sld ${NS}><p:cSld><p:spTree>
    <p:pic><p:nvPicPr><p:cNvPr id="9" name="p"/></p:nvPicPr>
      <p:blipFill><a:blip r:embed="rId2"/></p:blipFill>
      <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="500000"/></a:xfrm></p:spPr></p:pic>
    ${Array.from({ length: 100 }, (_, i) => `<p:sp><p:nvSpPr><p:cNvPr id="${i}" name="t${i}"/></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="200000"/></a:xfrm></p:spPr>
      <p:txBody><a:bodyPr/><a:p><a:r><a:t>${long}${n}</a:t></a:r></a:p></p:txBody></p:sp>`).join('')}
  </p:spTree></p:cSld></p:sld>`;
  const data = await makePptx({
    slides: [
      { name: 'slide1', xml: slide('一'), rels: slideRels() },
      { name: 'slide2', xml: slide('二'), rels: slideRels() },
    ],
    media: { 'ppt/media/image3.png': PNG_BYTES },
    master: false,
  });
  const sink = fakeResolver();

  await assert.rejects(
    () => importPptx({ data, resolveMedia: sink.resolveMedia }),
    /超过单个演示文稿 2048KB 的上限，先拆成几份导入吧/
  );
  assert.equal(sink.calls.length, 0, '一张图都不该被存过');
});
