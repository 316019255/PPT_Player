import test from 'node:test';
import assert from 'node:assert/strict';

import { importSlides, parseSlideSize, parseXml } from '../src/lib/pptx.ts';

const SLIDE_16_9 = '<p:sldSz cx="12192000" cy="6858000"/>';

const SLIDE_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="102030"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/></p:nvGrpSpPr>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title 1"/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="838200" y="365125"/><a:ext cx="10515600" cy="1320800"/></a:xfrm></p:spPr>
        <p:txBody>
          <a:bodyPr/>
          <a:p><a:pPr algn="ctr"/><a:r><a:rPr sz="4400" b="1"><a:solidFill><a:srgbClr val="FFCC00"/></a:solidFill></a:rPr><a:t>标题</a:t></a:r></a:p>
          <a:p><a:pPr/><a:r><a:rPr sz="1800" i="1"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:rPr><a:t>A &amp; B</a:t></a:r><a:br/><a:r><a:rPr sz="1800"/><a:t>第二行</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
      <p:grpSp>
        <p:nvGrpSpPr><p:cNvPr id="3" name="Group"/></p:nvGrpSpPr>
        <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="6858000"/><a:chOff x="0" y="0"/><a:chExt cx="6096000" cy="3429000"/></a:xfrm></p:grpSpPr>
        <p:sp>
          <p:nvSpPr><p:cNvPr id="4" name="Grouped"/></p:nvSpPr>
          <p:spPr><a:xfrm><a:off x="1000000" y="500000"/><a:ext cx="2000000" cy="800000"/></a:xfrm></p:spPr>
          <p:txBody><a:bodyPr/><a:p><a:pPr algn="r"/><a:r><a:rPr sz="2000"/><a:t>组内文字</a:t></a:r></a:p></p:txBody>
        </p:sp>
      </p:grpSp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="5" name="Inherited"/></p:nvSpPr>
        <p:txBody><a:bodyPr/><a:p><a:r><a:t>无坐标文字</a:t></a:r></a:p></p:txBody>
      </p:sp>
      <p:pic><p:nvPicPr><p:cNvPr id="6" name="Picture"/></p:nvPicPr></p:pic>
    </p:spTree>
  </p:cSld>
</p:sld>`;

function approx(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 0.01, `${message}: ${actual} != ${expected}`);
}

test('parseXml 解码实体并保留属性/自闭合结构', () => {
  const root = parseXml('<a:t xml:space="preserve">x &lt; y &amp; &#x4e2d;</a:t><a:off x="12" y="-3"/>');
  const text = root.children[0];
  assert.equal(text.name, 'a:t');
  assert.equal(text.attrs['xml:space'], 'preserve');
  assert.equal(text.text, 'x < y & 中');
  assert.deepEqual(root.children[1].attrs, { x: '12', y: '-3' });
  assert.equal(root.children[1].children.length, 0);
});

test('parseSlideSize 缺省按 16:9，异常值也回落', () => {
  assert.deepEqual(parseSlideSize(`<p:presentation>${SLIDE_16_9}</p:presentation>`), { cx: 12192000, cy: 6858000 });
  assert.deepEqual(parseSlideSize(undefined), { cx: 12192000, cy: 6858000 });
  assert.deepEqual(parseSlideSize('<p:presentation><p:sldSz cx="0" cy="0"/></p:presentation>'), {
    cx: 12192000,
    cy: 6858000,
  });
});

test('importSlides 按形状/段落/运行取样式，EMU 换算成百分比', () => {
  const { slides, skipped, warnings } = importSlides(
    [{ path: 'ppt/slides/slide1.xml', xml: SLIDE_XML }],
    { presentationXml: `<p:presentation>${SLIDE_16_9}</p:presentation>` }
  );

  assert.equal(slides.length, 1);
  assert.equal(slides[0].background.type, 'color');
  assert.equal(slides[0].background.value, '#102030');

  const blocks = slides[0].textBlocks;
  assert.equal(blocks.length, 3);

  const title = blocks[0];
  assert.equal(title.text, '标题\nA & B\n第二行');
  approx(title.x, 6.875, 'x');
  approx(title.y, 5.3244, 'y');
  approx(title.width, 86.25, 'width');
  approx(title.height, 19.2593, 'height');
  assert.equal(title.fontSize, 59); // 44pt * 96/72
  assert.equal(title.color, '#ffcc00');
  assert.equal(title.fontWeight, 'bold');
  assert.equal(title.textAlign, 'center');
  assert.equal(title.zIndex, 1);

  const grouped = blocks[1];
  assert.equal(grouped.text, '组内文字');
  approx(grouped.x, 16.4042, '组合后 x');
  approx(grouped.y, 14.583, '组合后 y');
  approx(grouped.width, 32.8084, '组合后 width');
  approx(grouped.height, 23.3304, '组合后 height');
  assert.equal(grouped.fontSize, 27);
  assert.equal(grouped.fontStyle, 'normal');
  assert.equal(grouped.textAlign, 'right');

  const inherited = blocks[2];
  assert.equal(inherited.text, '无坐标文字');
  assert.equal(inherited.x, 10);
  assert.equal(inherited.y, 48);
  assert.equal(inherited.width, 80);
  assert.equal(inherited.fontSize, 35); // 无 sz：按兜底框高估算
  assert.equal(inherited.color, '#ffffff');

  assert.deepEqual(skipped, { pictures: 1, videos: 0, charts: 0 });
  assert.match(warnings.join('\n'), /1 张图片没带位置或引用不到包里的文件/);
});

test('importSlides 空文本页只留提示，不造出假文字块', () => {
  const xml = `<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>   </a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  const { slides, warnings } = importSlides([{ path: 'ppt/slides/slide1.xml', xml }]);
  assert.equal(slides.length, 1);
  assert.deepEqual(slides[0].textBlocks, []);
  assert.equal(slides[0].background.value, '#1a1a2e');
  assert.match(warnings.join('\n'), /没有可导入的文字/);
});

test('importSlides 多页保持顺序并汇总跳过数量', () => {
  const empty = '<p:sld><p:cSld><p:spTree></p:spTree></p:cSld></p:sld>';
  const { slides, skipped, warnings } = importSlides([
    { path: 'ppt/slides/slide1.xml', xml: empty },
    { path: 'ppt/slides/slide2.xml', xml: SLIDE_XML },
  ]);
  assert.equal(slides.length, 2);
  assert.equal(slides[1].textBlocks.length, 3);
  assert.equal(skipped.pictures, 1);
  assert.match(warnings.join('\n'), /slide1/);
});

// ===== 背景 / 字体 / 换行 / 框高：幻灯片常常什么都不带，全靠母版+主题 =====

const THEME_XML = `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements>
  <a:clrScheme name="C">
    <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
    <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
    <a:dk2><a:srgbClr val="44546A"/></a:dk2>
    <a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
    <a:accent1><a:srgbClr val="4472C4"/></a:accent1>
    <a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
    <a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>
    <a:accent4><a:srgbClr val="FFC000"/></a:accent4>
    <a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>
    <a:accent6><a:srgbClr val="70AD47"/></a:accent6>
    <a:hlink><a:srgbClr val="0563C1"/></a:hlink>
    <a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
  </a:clrScheme>
  <a:fontScheme name="Office">
    <a:majorFont><a:latin typeface="Georgia"/><a:ea typeface="KaiTi"/></a:majorFont>
    <a:minorFont><a:latin typeface="Arial"/><a:ea typeface="Microsoft YaHei"/></a:minorFont>
  </a:fontScheme>
  <a:fmtScheme name="F">
    <a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
    <a:bgFillStyleLst>
      <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
      <a:gradFill rotWithShape="1"><a:gsLst>
        <a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="40000"/></a:schemeClr></a:gs>
        <a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="20000"/></a:schemeClr></a:gs>
      </a:gsLst></a:gradFill>
      <a:gradFill><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"/></a:gs></a:gsLst></a:gradFill>
    </a:bgFillStyleLst>
  </a:fmtScheme>
</a:themeElements></a:theme>`;

const MASTER_XML = `<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree/></p:cSld>
</p:sldMaster>`;

function rels(type, target) {
  return `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/></Relationships>`;
}

/** slide1 → slideLayout7 → slideMaster1 → theme1，路径全部按真实 pack 结构 */
const STYLE_PARTS = {
  'ppt/theme/theme1.xml': THEME_XML,
  'ppt/slideMasters/slideMaster1.xml': MASTER_XML,
  'ppt/slideMasters/_rels/slideMaster1.xml.rels': rels('theme', '../theme/theme1.xml'),
  'ppt/slideLayouts/slideLayout7.xml':
    '<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree/></p:cSld></p:sldLayout>',
  'ppt/slideLayouts/_rels/slideLayout7.xml.rels': rels('slideMaster', '../slideMasters/slideMaster1.xml'),
  'ppt/slides/_rels/slide1.xml.rels': rels('slideLayout', '../slideLayouts/slideLayout7.xml'),
};

const FIT_SLIDE = `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="t"/></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="5116195" y="2724150"/><a:ext cx="1954530" cy="198120"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>
      <p:txBody>
        <a:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t"><a:spAutoFit/></a:bodyPr>
        <a:p><a:r><a:rPr sz="2100"><a:solidFill><a:srgbClr val="8B6F47"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="KaiTi"/></a:rPr><a:t>尊 主 为 大</a:t></a:r></a:p>
      </p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sld>`;

function importFit(slideXml, extraParts = {}) {
  return importSlides([{ path: 'ppt/slides/slide1.xml', xml: slideXml }], {
    presentationXml: `<p:presentation>${SLIDE_16_9}</p:presentation>`,
    parts: { ...STYLE_PARTS, ...extraParts },
  });
}

test('importSlides 沿 slide→layout→master→theme 取页面底色，白底不再变深色', () => {
  const { slides } = importFit(FIT_SLIDE);
  assert.equal(slides[0].background.type, 'color');
  assert.equal(slides[0].background.value, '#ffffff');

  // 版式上的纯色背景优先于母版
  const layoutBg = importFit(FIT_SLIDE, {
    'ppt/slideLayouts/slideLayout7.xml':
      '<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="accent1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree/></p:cSld></p:sldLayout>',
  });
  assert.equal(layoutBg.slides[0].background.value, '#4472c4');
});

test('importSlides 把 p:bgRef 引用的主题渐变按首个色标近似，phClr + tint 要算对', () => {
  const { slides, warnings } = importFit(
    FIT_SLIDE.replace('<p:cSld><p:spTree>', '<p:cSld><p:bg><p:bgRef idx="1002"><a:schemeClr val="accent1"/></p:bgRef></p:bg><p:spTree>')
  );
  assert.equal(slides[0].background.value, '#8faadc'); // 4472C4 提亮 40%
  assert.match(warnings.join('\n'), /渐变背景/);
});

test('importSlides 保留 wrap=none、insets 和真实框高', () => {
  const [block] = importFit(FIT_SLIDE).slides[0].textBlocks;
  approx(block.height, 2.889, '框高不再抬到 4% 下限');
  assert.equal(block.wrap, false);
  assert.equal(block.padding, 0);
  assert.equal(block.fontSize, 28);
  assert.equal(block.color, '#8b6f47');
});

test('importSlides 把 latin/ea 字族拼成 CSS font-family，+mn-lt 走主题', () => {
  const [block] = importFit(FIT_SLIDE).slides[0].textBlocks;
  assert.equal(block.fontFamily, '"Arial", "KaiTi"');

  const major = importFit(FIT_SLIDE.replace('typeface="+mn-lt"', 'typeface="+mj-ea"')).slides[0].textBlocks[0];
  assert.equal(major.fontFamily, '"KaiTi"');
});

// ===== 文字颜色继承：真实 PPT 的 run 往往什么都不写，颜色全在母版 txStyles / 占位符 lstStyle 里 =====

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

const INHERIT_MASTER = `<p:sldMaster ${NS}>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2"/>
  <p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>
    <p:sp><p:nvSpPr><p:cNvPr id="1" name="标题"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:bodyPr/><a:lstStyle><a:lvl1pPr><a:defRPr sz="4000"/></a:lvl1pPr></a:lstStyle><a:p><a:endParaRPr/></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld>
  <p:txStyles>
    <p:titleStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="4400" b="0"><a:solidFill><a:schemeClr val="tx2"/></a:solidFill><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/></a:defRPr></a:lvl1pPr></p:titleStyle>
    <p:bodyStyle>
      <a:lvl1pPr algn="l"><a:defRPr sz="3200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr>
      <a:lvl2pPr algn="l"><a:defRPr sz="2800" b="1"><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:defRPr></a:lvl2pPr>
    </p:bodyStyle>
    <p:otherStyle><a:lvl1pPr algn="l"><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr></p:otherStyle>
  </p:txStyles>
</p:sldMaster>`;

const INHERIT_LAYOUT = `<p:sldLayout ${NS}><p:cSld><p:spTree>
  <p:sp><p:nvSpPr><p:cNvPr id="2" name="标题"/><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr>
    <p:txBody><a:bodyPr/><a:lstStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="4500"/></a:lvl1pPr></a:lstStyle><a:p><a:endParaRPr/></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sldLayout>`;

const INHERIT_SLIDE = `<p:sld ${NS}><p:cSld><p:spTree>
  <p:sp><p:nvSpPr><p:cNvPr id="3" name="标题 2"/><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr>
    <p:spPr><a:xfrm><a:off x="838200" y="365125"/><a:ext cx="10515600" cy="1320800"/></a:xfrm></p:spPr>
    <p:txBody><a:bodyPr/><a:p><a:r><a:t>没有颜色的标题</a:t></a:r></a:p></p:txBody></p:sp>
  <p:sp><p:nvSpPr><p:cNvPr id="4" name="内容 3"/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
    <p:spPr><a:xfrm><a:off x="838200" y="2000000"/><a:ext cx="10515600" cy="1320800"/></a:xfrm></p:spPr>
    <p:txBody><a:bodyPr/><a:p><a:r><a:t>正文一级</a:t></a:r></a:p></p:txBody></p:sp>
  <p:sp><p:nvSpPr><p:cNvPr id="5" name="内容 4"/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
    <p:spPr><a:xfrm><a:off x="838200" y="3500000"/><a:ext cx="10515600" cy="1320800"/></a:xfrm></p:spPr>
    <p:txBody><a:bodyPr/><a:p><a:pPr lvl="1"/><a:r><a:t>正文二级</a:t></a:r></a:p></p:txBody></p:sp>
  <p:sp><p:nvSpPr><p:cNvPr id="6" name="文本框 5"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
    <p:spPr><a:xfrm><a:off x="838200" y="5000000"/><a:ext cx="10515600" cy="1320800"/></a:xfrm></p:spPr>
    <p:txBody><a:bodyPr/><a:p><a:r><a:t>纯文本框</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>`;

function importInherited() {
  return importFit(INHERIT_SLIDE, {
    'ppt/slideMasters/slideMaster1.xml': INHERIT_MASTER,
    'ppt/slideLayouts/slideLayout7.xml': INHERIT_LAYOUT,
  }).slides[0].textBlocks;
}

test('importSlides 沿 版式占位符 > 母版占位符 > 母版 txStyles 补齐文字颜色与字号', () => {
  const [title, body, level2, box] = importInherited();

  // tx2 → dk2 → 44546A：这是源文件里唯一的颜色来源
  assert.equal(title.color, '#44546a');
  assert.equal(title.fontSize, 60); // 版式 lstStyle 的 4500 优先于母版的 4000/txStyles 的 4400
  assert.equal(title.textAlign, 'center');
  assert.equal(title.fontWeight, 'normal'); // txStyles 里显式 b="0"
  assert.equal(title.fontFamily, '"Georgia", "KaiTi"'); // +mj-lt / +mj-ea

  assert.equal(body.color, '#000000'); // tx1 → dk1
  assert.equal(body.fontSize, 43);
  assert.equal(body.textAlign, 'left');

  assert.equal(level2.color, '#4472c4'); // 段落 lvl=1 走 bodyStyle 的 lvl2pPr
  assert.equal(level2.fontSize, 37);
  assert.equal(level2.fontWeight, 'bold');

  assert.equal(box.color, '#000000'); // 无占位符 → otherStyle
  assert.equal(box.fontSize, 24);
});

test('整条继承链都没有颜色时，按页面底色取对比色而不是写死白色', () => {
  const [block] = importFit(FIT_SLIDE.replace(/<a:solidFill><a:srgbClr val="8B6F47"\/><\/a:solidFill>/, '')).slides[0]
    .textBlocks;
  assert.equal(block.color, '#202020'); // 母版背景是 #ffffff
});

// ===== 装饰色块 + 图片：解析层只给部件路径与几何，字节存到哪由浏览器导入器决定 =====

const IMG_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

/** slide1 同时挂版式（rId1）与图片（rId2）两条关系，供 relById 解析 */
function slideRelsWithImage(imgTarget) {
  return `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout7.xml"/>
    <Relationship Id="rId2" Type="${IMG_REL}" Target="${imgTarget}"/>
  </Relationships>`;
}

test('没有文字但有填充的形状导出为装饰色块，无底板又无文字的形状仍被丢弃', () => {
  const xml = `<p:sld ${NS}><p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:cNvPr id="2" name="panel"/></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="6096000" cy="3429000"/></a:xfrm>
        <a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 10000"/></a:avLst></a:prstGeom>
        <a:solidFill><a:srgbClr val="15857A"/></a:solidFill></p:spPr>
      <p:txBody><a:bodyPr/><a:p><a:endParaRPr/></a:p></p:txBody></p:sp>
    <p:sp><p:nvSpPr><p:cNvPr id="3" name="txt"/></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="1000000" y="1000000"/><a:ext cx="4000000" cy="800000"/></a:xfrm><a:noFill/></p:spPr>
      <p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="2400"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>标题文字</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:nvSpPr><p:cNvPr id="4" name="empty"/></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="0" y="5000000"/><a:ext cx="1000" cy="1000"/></a:xfrm><a:noFill/></p:spPr>
      <p:txBody><a:bodyPr/><a:p><a:endParaRPr/></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld></p:sld>`;
  const blocks = importFit(xml).slides[0].textBlocks;

  assert.equal(blocks.length, 2); // 第三个既无文字又无填充 → 丢弃
  assert.equal(blocks[0].text, '');
  assert.equal(blocks[0].bgColor, '#15857a');
  assert.ok(blocks[0].borderRadius > 0);
  assert.equal(blocks[0].zIndex, 1);
  assert.equal(blocks[1].text, '标题文字');
  assert.equal(blocks[1].zIndex, 2);
});

test('p:bg 用图片时记下媒体部件，页面仍保留纯色兜底', () => {
  const xml = `<p:sld ${NS}><p:cSld>
    <p:bg><p:bgPr><a:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>
    <p:spTree/>
  </p:cSld></p:sld>`;
  const report = importFit(xml, { 'ppt/slides/_rels/slide1.xml.rels': slideRelsWithImage('../media/image9.png') });

  assert.equal(report.slides[0].background.type, 'color');
  assert.equal(report.slides[0].background.value, '#ffffff'); // 母版兜底，落盘前仍是纯色
  assert.equal(report.imageBackgrounds.length, 1);
  assert.equal(report.imageBackgrounds[0].part, 'ppt/media/image9.png');
  assert.equal(report.imageBackgrounds[0].slideId, report.slides[0].id);
});

test('整页大图作为第一个形状时识别成背景，不再计入跳过图片', () => {
  const xml = `<p:sld ${NS}><p:cSld><p:spTree>
    <p:pic><p:nvPicPr><p:cNvPr id="2" name="bg"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
      <p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
      <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="6858000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
    </p:pic>
    <p:sp><p:nvSpPr><p:cNvPr id="3" name="t"/></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="1000000" y="1000000"/><a:ext cx="4000000" cy="800000"/></a:xfrm><a:noFill/></p:spPr>
      <p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="2400"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>叠加文字</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld></p:sld>`;
  const report = importFit(xml, { 'ppt/slides/_rels/slide1.xml.rels': slideRelsWithImage('../media/image5.jpg') });

  assert.equal(report.skipped.pictures, 0); // 大图已当背景用，不再算“跳过”
  assert.equal(report.imageBackgrounds.length, 1);
  assert.equal(report.imageBackgrounds[0].part, 'ppt/media/image5.jpg');
  assert.equal(report.slides[0].background.type, 'color');
  assert.equal(report.slides[0].textBlocks[0].text, '叠加文字');
  assert.doesNotMatch(report.warnings.join('\n'), /张图片/);
});

// ===== 保真修复：占位符缺省 type / 单块对齐 / normAutofit 缩放 / 多行兜底字号 =====

/** 母版 bodyStyle 左对齐 1800 / titleStyle 居中 4400，正文和标题一眼能分辨谁套了哪一档 */
const RES_MASTER = `<p:sldMaster ${NS}>
  <p:clrMap bg1="lt1" tx1="dk1" tx2="dk2"/>
  <p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree/></p:cSld>
  <p:txStyles>
    <p:titleStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="4400"><a:solidFill><a:schemeClr val="tx2"/></a:solidFill></a:defRPr></a:lvl1pPr></p:titleStyle>
    <p:bodyStyle><a:lvl1pPr algn="l"><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr></p:bodyStyle>
    <p:otherStyle><a:lvl1pPr algn="l"><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr></p:otherStyle>
  </p:txStyles>
</p:sldMaster>`;

const BODY_BOX = `<p:spPr><a:xfrm><a:off x="838200" y="2000000"/><a:ext cx="10515600" cy="1320800"/></a:xfrm></p:spPr>`;

function resParts(layoutXml, masterXml) {
  return {
    ...STYLE_PARTS,
    'ppt/slideMasters/slideMaster1.xml': masterXml ?? RES_MASTER,
    ...(layoutXml ? { 'ppt/slideLayouts/slideLayout7.xml': layoutXml } : {}),
  };
}

test('A1：只有 idx 没写 type 的正文占位符不再当成 title，按版式同名 idx 校正为 body', () => {
  // 版式里 idx=1 是 body，幻灯片只写了 idx="1"
  const layout = `<p:sldLayout ${NS}><p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:cNvPr id="2" name="b"/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:bodyPr/></p:txBody></p:sp>
  </p:spTree></p:cSld></p:sldLayout>`;
  const slide = `<p:sld ${NS}><p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:cNvPr id="3" name="t"/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr>
      ${BODY_BOX}<p:txBody><a:bodyPr/><a:p><a:r><a:t>正文</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld></p:sld>`;
  const [block] = importFit(slide, resParts(layout)).slides[0].textBlocks;

  // 修复前：idx=1 缺 type → 误当 title → titleStyle 居中 4400（59px）
  assert.equal(block.textAlign, 'left');
  assert.equal(block.fontSize, 24); // bodyStyle 1800
});

test('A1：无 idx 的缺省占位符仍按规范的 title；有 idx 但链上查不到则落 body，绝不落 title', () => {
  const layout = `<p:sldLayout ${NS}><p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:cNvPr id="2" name="ti"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:bodyPr/></p:txBody></p:sp>
  </p:spTree></p:cSld></p:sldLayout>`;
  const slide = `<p:sld ${NS}><p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:cNvPr id="3" name="t"/><p:nvPr><p:ph/></p:nvPr></p:nvSpPr>
      ${BODY_BOX}<p:txBody><a:bodyPr/><a:p><a:r><a:t>标题</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:nvSpPr><p:cNvPr id="4" name="x"/><p:nvPr><p:ph idx="9"/></p:nvPr></p:nvSpPr>
      ${BODY_BOX}<p:txBody><a:bodyPr/><a:p><a:r><a:t>查不到的正文</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld></p:sld>`;
  const [title, orphan] = importFit(slide, resParts(layout)).slides[0].textBlocks;

  assert.equal(title.textAlign, 'center'); // 规范缺省：无 idx → title
  assert.equal(title.fontSize, 59);
  assert.equal(orphan.textAlign, 'left'); // idx=9 版式/母版都没有 → body，不是 title
  assert.equal(orphan.fontSize, 24);
});

test('A2：单块对齐优先取显式写过 algn 的段落，而不是无条件用首段或全体多数', () => {
  // 首段显式右对齐，其余段默认落 left → 块应落在显式的 right
  const slide = `<p:sld ${NS}><p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:cNvPr id="2" name="b"/><p:nvPr><p:ph type="body" idx="9"/></p:nvPr></p:nvSpPr>
      ${BODY_BOX}<p:txBody><a:bodyPr/><a:p><a:pPr algn="r"/><a:r><a:t>右</a:t></a:r></a:p><a:p><a:r><a:t>甲</a:t></a:r></a:p><a:p><a:r><a:t>乙</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld></p:sld>`;
  const [block] = importFit(slide, resParts()).slides[0].textBlocks;
  assert.equal(block.textAlign, 'right');
});

test('A2：段落全部没写 algn 时，用继承来的对齐取多数而不是首段', () => {
  const master = RES_MASTER.replace(
    '<p:bodyStyle><a:lvl1pPr algn="l">',
    '<p:bodyStyle><a:lvl2pPr algn="ctr"/><a:lvl1pPr algn="l">'
  );
  // lvl1=left(×2)、lvl2=center(×1) → 多数 left
  const slide = `<p:sld ${NS}><p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:cNvPr id="2" name="b"/><p:nvPr><p:ph type="body" idx="9"/></p:nvPr></p:nvSpPr>
      ${BODY_BOX}<p:txBody><a:bodyPr/><a:p><a:r><a:t>一</a:t></a:r></a:p><a:p><a:pPr lvl="1"/><a:r><a:t>二</a:t></a:r></a:p><a:p><a:r><a:t>三</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld></p:sld>`;
  const [block] = importFit(slide, resParts(undefined, master)).slides[0].textBlocks;
  assert.equal(block.textAlign, 'left');
});

test('B1：读取 bodyPr/a:normAutofit@fontScale 还原 PowerPoint 已经缩过的字号', () => {
  const fitted = FIT_SLIDE.replace('<a:spAutoFit/>', '<a:normAutofit fontScale="70000"/>').replace(
    'sz="2100"',
    'sz="3200"'
  );
  const [scaleBlock] = importFit(fitted).slides[0].textBlocks;
  assert.equal(scaleBlock.fontSize, 30); // 32pt→43px，再 ×0.7 → 30

  const [autoFit] = importFit(FIT_SLIDE).slides[0].textBlocks;
  assert.equal(autoFit.fontSize, 28); // spAutoFit 不缩放，仍是 21pt→28px
});

test('B2：兜底字号按实际行数摊分（固定框高时），不再假设单行', () => {
  const box = `<p:spPr><a:xfrm><a:off x="838200" y="365125"/><a:ext cx="10515600" cy="1320800"/></a:xfrm></p:spPr>`;
  const oneLine = `<p:sld ${NS}><p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:cNvPr id="5" name="i"/></p:nvSpPr>${box}
      <p:txBody><a:bodyPr/><a:p><a:r><a:t>一行</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld></p:sld>`;
  const threeLines = oneLine.replace(
    '<a:p><a:r><a:t>一行</a:t></a:r></a:p>',
    '<a:p><a:r><a:t>甲</a:t></a:r></a:p><a:p><a:r><a:t>乙</a:t></a:r></a:p><a:p><a:r><a:t>丙</a:t></a:r></a:p>'
  );
  const [single] = importFit(oneLine).slides[0].textBlocks;
  const [multi] = importFit(threeLines).slides[0].textBlocks;

  assert.ok(multi.fontSize < single.fontSize, `同样框高下 3 行应比 1 行小：${multi.fontSize} !< ${single.fontSize}`);
  assert.ok(Math.abs(multi.fontSize - single.fontSize / 3) <= 1, `3 行约等于 1 行的三分之一：${multi.fontSize} vs ${single.fontSize / 3}`);
  assert.ok(multi.fontSize >= 12, `不能低于兜底下限 12：${multi.fontSize}`);
});

// ===== 阶段 3：正文图片抽成槽位，字节去向由调用方决定 =====

test('正文 p:pic 抽成槽位：百分比几何、fit 默认 fill、alt 取 descr、层叠与文字共用一个计数器', () => {
  const xml = `<p:sld ${NS}><p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:cNvPr id="2" name="a"/></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1219200" cy="685800"/></a:xfrm></p:spPr>
      <p:txBody><a:bodyPr/><a:p><a:r><a:t>第一块</a:t></a:r></a:p></p:txBody></p:sp>
    <p:pic><p:nvPicPr><p:cNvPr id="3" name="图片 3" descr="诗歌配图"/></p:nvPicPr>
      <p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
      <p:spPr><a:xfrm><a:off x="6096000" y="3429000"/><a:ext cx="4064000" cy="2286000"/></a:xfrm></p:spPr>
    </p:pic>
    <p:sp><p:nvSpPr><p:cNvPr id="4" name="b"/></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="0" y="6000000"/><a:ext cx="1219200" cy="685800"/></a:xfrm></p:spPr>
      <p:txBody><a:bodyPr/><a:p><a:r><a:t>第三块</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld></p:sld>`;
  const report = importFit(xml, { 'ppt/slides/_rels/slide1.xml.rels': slideRelsWithImage('../media/image3.png') });
  const [slot] = report.imageSlots;

  assert.equal(report.slides[0].imageBlocks.length, 0); // 来源解析完之前不造假块
  assert.equal(report.imageSlots.length, 1);
  assert.equal(slot.part, 'ppt/media/image3.png');
  assert.equal(slot.slideId, report.slides[0].id);
  approx(slot.x, 50, 'x');
  approx(slot.y, 50, 'y');
  approx(slot.width, 33.3333, 'width');
  approx(slot.height, 33.3333, 'height');
  assert.equal(slot.fit, 'fill'); // pptx 默认按 a:stretch 拉满自己的框
  assert.equal(slot.alt, '诗歌配图');
  assert.equal(slot.zIndex, 2); // 出现在第一块文字之后、第三块之前
  assert.equal(report.slides[0].textBlocks[0].zIndex, 1);
  assert.equal(report.slides[0].textBlocks[1].zIndex, 3);
  assert.equal(report.skipped.pictures, 0);
});

test('裁剪过的图按 cover，旋转/翻转与平铺只能近似，三种各计一次并写进告警', () => {
  const pic = (id, fill, xfrmAttrs = '') => `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="p${id}"/></p:nvPicPr>
      <p:blipFill>${fill}</p:blipFill>
      <p:spPr><a:xfrm${xfrmAttrs}><a:off x="0" y="0"/><a:ext cx="1219200" cy="685800"/></a:xfrm></p:spPr></p:pic>`;
  const xml = `<p:sld ${NS}><p:cSld><p:spTree>
    ${pic(3, '<a:blip r:embed="rId2"/><a:srcRect l="10000" t="10000"/><a:stretch><a:fillRect/></a:stretch>')}
    ${pic(4, '<a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch>', ' rot="5400000"')}
    ${pic(5, '<a:blip r:embed="rId2"/><a:tile/>')}
  </p:spTree></p:cSld></p:sld>`;
  const report = importFit(xml, { 'ppt/slides/_rels/slide1.xml.rels': slideRelsWithImage('../media/image3.png') });
  const [cropped, rotated, tiled] = report.imageSlots;

  assert.equal(cropped.fit, 'cover');
  assert.equal(rotated.fit, 'fill');
  assert.equal(tiled.fit, 'fill');
  assert.deepEqual(report.pictureApprox, { cropped: 1, rotated: 1, tiled: 1 });

  const warnings = report.warnings.join('\n');
  assert.match(warnings, /1 张图片在源文件里被裁过/);
  assert.match(warnings, /1 张图片带旋转或翻转/);
  assert.match(warnings, /1 张图片是平铺填充/);
});

test('只有引用不到部件或没带位置的图才算跳过，抽成槽位的一律不再报跳过', () => {
  const xml = `<p:sld ${NS}><p:cSld><p:spTree>
    <p:pic><p:nvPicPr><p:cNvPr id="3" name="ok"/></p:nvPicPr>
      <p:blipFill><a:blip r:embed="rId2"/></p:blipFill>
      <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1219200" cy="685800"/></a:xfrm></p:spPr></p:pic>
    <p:pic><p:nvPicPr><p:cNvPr id="4" name="dangling"/></p:nvPicPr>
      <p:blipFill><a:blip r:embed="rId99"/></p:blipFill>
      <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1219200" cy="685800"/></a:xfrm></p:spPr></p:pic>
    <p:pic><p:nvPicPr><p:cNvPr id="5" name="nobox"/></p:nvPicPr>
      <p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic>
  </p:spTree></p:cSld></p:sld>`;
  const report = importFit(xml, { 'ppt/slides/_rels/slide1.xml.rels': slideRelsWithImage('../media/image3.png') });

  assert.equal(report.imageSlots.length, 1);
  assert.equal(report.skipped.pictures, 2); // rId99 查不到 + 完全没有 xfrm
  assert.match(report.warnings.join('\n'), /2 张图片没带位置或引用不到包里的文件/);
});

test('被当成整页底图那张不重复抽成正文块，同页另一张正文图照旧抽出', () => {
  const rels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout7.xml"/>
    <Relationship Id="rId2" Type="${IMG_REL}" Target="../media/image5.jpg"/>
    <Relationship Id="rId3" Type="${IMG_REL}" Target="../media/image6.png"/>
  </Relationships>`;
  const xml = `<p:sld ${NS}><p:cSld><p:spTree>
    <p:pic><p:nvPicPr><p:cNvPr id="2" name="bg"/></p:nvPicPr>
      <p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
      <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="6858000"/></a:xfrm></p:spPr></p:pic>
    <p:pic><p:nvPicPr><p:cNvPr id="3" name="logo"/></p:nvPicPr>
      <p:blipFill><a:blip r:embed="rId3"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
      <p:spPr><a:xfrm><a:off x="0" y="6000000"/><a:ext cx="1219200" cy="685800"/></a:xfrm></p:spPr></p:pic>
  </p:spTree></p:cSld></p:sld>`;
  const report = importFit(xml, { 'ppt/slides/_rels/slide1.xml.rels': rels });

  assert.equal(report.imageBackgrounds.length, 1);
  assert.equal(report.imageBackgrounds[0].part, 'ppt/media/image5.jpg');
  assert.equal(report.imageSlots.length, 1);
  assert.equal(report.imageSlots[0].part, 'ppt/media/image6.png');
  assert.equal(report.imageSlots[0].zIndex, 1); // 这一页没有文字块，第一层就是它
  assert.equal(report.skipped.pictures, 0);
});

test('组里的图片按组的缩放比例换算到页面坐标，和文字块走同一套换算', () => {
  const xml = `<p:sld ${NS}><p:cSld><p:spTree>
    <p:grpSp><p:nvGrpSpPr><p:cNvPr id="2" name="Group"/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="6858000"/><a:chOff x="0" y="0"/><a:chExt cx="6096000" cy="3429000"/></a:xfrm></p:grpSpPr>
      <p:pic><p:nvPicPr><p:cNvPr id="3" name="pic"/></p:nvPicPr>
        <p:blipFill><a:blip r:embed="rId2"/></p:blipFill>
        <p:spPr><a:xfrm><a:off x="1000000" y="500000"/><a:ext cx="2000000" cy="800000"/></a:xfrm></p:spPr></p:pic>
    </p:grpSp>
  </p:spTree></p:cSld></p:sld>`;
  const report = importFit(xml, { 'ppt/slides/_rels/slide1.xml.rels': slideRelsWithImage('../media/image3.png') });
  const [slot] = report.imageSlots;

  // 组放大 2 倍：期望值与 SLIDE_XML 里「组内文字」的那一组数字一致
  approx(slot.x, 16.4042, '组合后 x');
  approx(slot.y, 14.583, '组合后 y');
  approx(slot.width, 32.8084, '组合后 width');
  approx(slot.height, 23.3304, '组合后 height');
});
