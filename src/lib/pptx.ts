import type { ImageFit, Slide, TextBlock } from '@/types/ppt';

/**
 * 无第三方依赖的轻量 OOXML 读取：关心版式信息
 * （位置、段落对齐、运行级字号/粗斜体/颜色/字体、纯色与主题背景、文本框填充与边框），
 * 以及哪些内容是明确丢弃的（视频、图表、母版继承的文字）。
 *
 * 背景与主题色必须顺着 pack:// 的关系链走：
 * slide → slideLayout → slideMaster → theme，幻灯片自己往往不带 p:bg。
 */

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** 仅叶子文本节点有值（<a:t> 里的文字） */
  text: string;
}

export interface PptxSlideSource {
  path: string;
  xml: string;
}

export interface PptxImportOptions {
  presentationXml?: string;
  /** 幻灯片之外的相关部件：母版、版式、主题、以及所有 _rels/*.rels */
  parts?: Record<string, string>;
}

/** 需要从包里取出的图片背景：part 是包内路径，由调用方落盘后换成可访问 URL */
export interface ImageBackgroundRef {
  slideId: string;
  part: string;
}

/**
 * 页面上的正文图片：几何已经换算成百分比，来源待定。
 * 这里只给「该放哪、多大、第几层」，因为 src 要等调用方把 part 的字节存到某处才有，
 * 而存到哪（云端桶 / 本机库）是导入那一刻才决定的，不该由 OOXML 解析层管。
 */
export interface ImageSlot {
  slideId: string;
  part: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fit: ImageFit;
  alt: string;
  zIndex: number;
}

/** 图片自身带得上、但本播放器的模型装不下的效果，逐个计数好写进告警 */
export interface PictureApprox {
  cropped: number;
  rotated: number;
  tiled: number;
}

export interface ImportReport {
  slides: Slide[];
  skipped: { pictures: number; videos: number; charts: number };
  /**
   * 这些页的背景是图片：slides 里暂时填的是可用的纯色兜底，
   * 调用方把 part 落成静态资源后再改成图片背景。
   */
  imageBackgrounds: ImageBackgroundRef[];
  /** 正文图片：slides 里暂时是空的 imageBlocks，调用方解析出 src 后按 slideId 填进去 */
  imageSlots: ImageSlot[];
  pictureApprox: PictureApprox;
  warnings: string[];
}

const EMU_PER_PT = 12700;
const EMU_PER_PX = 9525;
const PX_PER_PT = 96 / 72;

/** 没有 theme 部件时的兜底：本播放器的页面底色默认偏深，所以浅色系按白字处理 */
const SCHEME_COLORS: Record<string, string> = {
  lt1: '#ffffff',
  bg1: '#ffffff',
  bg2: '#ffffff',
  tx1: '#202020',
  dk1: '#202020',
  tx2: '#ffffff',
  lt2: '#202020',
};

/** p:clrMap 的默认映射：幻灯片里的 bg1/tx1 槽位指向主题里的哪个色 */
const DEFAULT_CLR_MAP: Record<string, string> = {
  bg1: 'lt1',
  tx1: 'dk1',
  bg2: 'lt2',
  tx2: 'dk2',
  accent1: 'accent1',
  accent2: 'accent2',
  accent3: 'accent3',
  accent4: 'accent4',
  accent5: 'accent5',
  accent6: 'accent6',
  hlink: 'hlink',
  folhlink: 'folhlink',
};

export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  let i = 0;

  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) break;

    // 元素之间的裸文本（OOXML 里只有 <a:t> 有意义，交给叶子处理）
    const raw = xml.slice(i, lt);
    if (raw.trim()) {
      const parent = stack[stack.length - 1];
      parent.text += decodeEntities(raw);
    }

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt);
      i = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt);
      const parent = stack[stack.length - 1];
      parent.text += xml.slice(lt + 9, end < 0 ? xml.length : end);
      i = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt);
      i = end < 0 ? xml.length : end + 2;
      continue;
    }
    if (xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt);
      i = end < 0 ? xml.length : end + 1;
      continue;
    }

    const gt = xml.indexOf('>', lt + 1);
    if (gt < 0) break;
    const inner = xml.slice(lt + 1, gt);
    i = gt + 1;

    if (inner.startsWith('/')) {
      const closing = inner.slice(1).trim();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === closing) {
          stack.length = k;
          break;
        }
      }
      continue;
    }

    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const nameMatch = body.match(/^([^\s/>]+)/);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const attrs: Record<string, string> = {};
    const attrRe = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(body.slice(name.length))) !== null) {
      attrs[m[1]] = decodeEntities(m[3] ?? m[4] ?? '');
    }

    const node: XmlNode = { name, attrs, children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }

  return root;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function walk(node: XmlNode, visit: (n: XmlNode, chain: XmlNode[]) => void, chain: XmlNode[] = []): void {
  for (const child of node.children) {
    visit(child, [...chain, node]);
    walk(child, visit, [...chain, node]);
  }
}

function findAll(node: XmlNode | undefined, name: string): XmlNode[] {
  if (!node) return [];
  const out: XmlNode[] = [];
  walk(node, (n) => {
    if (n.name === name) out.push(n);
  });
  return out;
}

function findFirst(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return findAll(node, name)[0];
}

/** 只找直接子节点：区分 <p:spPr> 自己的填充和它孙节点里 runs 的填充 */
function directChild(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return node?.children.find((c) => c.name === name);
}

function directChildren(node: XmlNode | undefined, prefix: string): XmlNode[] {
  return node ? node.children.filter((c) => c.name.startsWith(prefix)) : [];
}

function intAttr(attrs: Record<string, string>, key: string): number | null {
  const raw = attrs[key];
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function clampPct(value: number, size: number): number {
  return Math.max(0, Math.min(100, (value / size) * 100));
}

const HEX6 = /^#([0-9a-f]{6})$/i;

function normalizeHex(raw: string): string | null {
  if (!/^([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(raw)) return null;
  return `#${raw.slice(-6)}`.toLowerCase();
}

function rgbToHex(r: number, g: number, b: number): string {
  const part = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = HEX6.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    const v = ((t % 1) + 1) % 1;
    if (v < 1 / 6) return p + (q - p) * 6 * v;
    if (v < 1 / 2) return q;
    if (v < 2 / 3) return p + (q - p) * (2 / 3 - v) * 6;
    return p;
  };
  return [hue(h + 1 / 3) * 255, hue(h) * 255, hue(h - 1 / 3) * 255];
}

/**
 * schemeClr / srgbClr 上挂的颜色变换，按文档顺序叠加。
 * 主题的 bgFillStyleLst 和大部分强调色填充都靠它，漏掉会整体偏色。
 * a:alpha（文字半透明）这里不接：模型里有 TextBlock.opacity，但这条链路只产出色值，
 * 导入的半透明文字要保真得改所有取色调用点，先不做。
 */
function applyColorTransforms(hex: string, colorNode: XmlNode): string {
  const start = hexToRgb(hex);
  if (!start) return hex;
  let [r, g, b] = start;

  for (const child of colorNode.children) {
    const val = intAttr(child.attrs, 'val');
    if (val === null) continue;
    const f = val / 100000;
    if (child.name === 'a:shade') {
      r *= f;
      g *= f;
      b *= f;
    } else if (child.name === 'a:tint') {
      r += (255 - r) * f;
      g += (255 - g) * f;
      b += (255 - b) * f;
    } else if (child.name === 'a:gray') {
      const avg = (r + g + b) / 3;
      r = g = b = avg;
    } else if (child.name === 'a:satMod' || child.name === 'a:lumMod' || child.name === 'a:lumOff') {
      const [h, s, l] = rgbToHsl(r, g, b);
      const next = hslToRgb(
        h,
        child.name === 'a:satMod' ? Math.min(1, s * f) : s,
        child.name === 'a:lumMod' ? Math.min(1, l * f) : child.name === 'a:lumOff' ? Math.min(1, l + f) : l
      );
      r = next[0];
      g = next[1];
      b = next[2];
    }
  }
  return rgbToHex(r, g, b);
}

interface ThemeInfo {
  /** 键已转小写：dk1/lt1/dk2/lt2/accent1-6/hlink/folhlink */
  colors: Record<string, string>;
  major: { latin: string; ea: string };
  minor: { latin: string; ea: string };
  fillStyles: XmlNode[];
  bgFillStyles: XmlNode[];
}

interface StyleCtx {
  theme: ThemeInfo | null;
  clrMap: Record<string, string>;
}

function parseTheme(xml: string | undefined): ThemeInfo | null {
  if (!xml) return null;
  const doc = parseXml(xml);
  const scheme = findFirst(doc, 'a:clrScheme');
  if (!scheme) return null;

  const colors: Record<string, string> = {};
  for (const entry of scheme.children) {
    const raw = entry.children[0];
    if (!raw) continue;
    const hex = raw.name === 'a:srgbClr' ? raw.attrs.val : raw.name === 'a:sysClr' ? raw.attrs.lastClr : undefined;
    const normalized = hex ? normalizeHex(hex) : null;
    if (normalized) colors[entry.name.replace(/^a:/, '').toLowerCase()] = normalized;
  }

  const fontsOf = (slot: string) => {
    const node = findFirst(doc, `a:${slot}Font`);
    return {
      latin: directChild(node, 'a:latin')?.attrs.typeface ?? '',
      ea: directChild(node, 'a:ea')?.attrs.typeface ?? '',
    };
  };
  const fillList = (name: string) => directChildren(findFirst(findFirst(doc, 'a:fmtScheme'), name), 'a:');

  return {
    colors,
    major: fontsOf('major'),
    minor: fontsOf('minor'),
    fillStyles: fillList('a:fillStyleLst'),
    bgFillStyles: fillList('a:bgFillStyleLst'),
  };
}

function parseClrMap(masterXml: string | undefined): Record<string, string> {
  if (!masterXml) return DEFAULT_CLR_MAP;
  const node = findFirst(parseXml(masterXml), 'p:clrMap');
  if (!node) return DEFAULT_CLR_MAP;
  const map: Record<string, string> = { ...DEFAULT_CLR_MAP };
  for (const [key, value] of Object.entries(node.attrs)) map[key.toLowerCase()] = value.toLowerCase();
  return map;
}

/** schemeClr 槽位 → 主题色；主题缺失时退回按深浅猜的兜底表 */
function resolveSchemeColor(val: string, ctx: StyleCtx, phClr: string | null): string | null {
  if (!val) return null;
  if (val === 'phClr') return phClr;
  if (!ctx.theme) return SCHEME_COLORS[val] ?? null;
  const slot = (ctx.clrMap[val.toLowerCase()] ?? val).toLowerCase();
  return ctx.theme.colors[slot] ?? ctx.theme.colors[val.toLowerCase()] ?? SCHEME_COLORS[val] ?? null;
}

/** 从一个 a:srgbClr / a:schemeClr 颜色节点取出最终色值 */
function colorOfColorNode(node: XmlNode | undefined, ctx: StyleCtx, phClr: string | null): string | null {
  if (!node) return null;
  if (node.name === 'a:srgbClr') {
    const hex = normalizeHex(node.attrs.val ?? '');
    return hex ? applyColorTransforms(hex, node) : null;
  }
  if (node.name === 'a:sysClr') {
    const base = normalizeHex(node.attrs.lastClr ?? '');
    return base ? applyColorTransforms(base, node) : null;
  }
  if (node.name === 'a:schemeClr') {
    const base = resolveSchemeColor(node.attrs.val ?? '', ctx, phClr);
    return base ? applyColorTransforms(base, node) : null;
  }
  return null;
}

type FillKind = 'solid' | 'gradient' | 'image' | 'none';

interface ResolvedFill {
  kind: FillKind;
  color: string | null;
  /** 图片填充时 a:blip@r:embed 的关系 id，需要在该部件自己的 .rels 里查目标 */
  relId?: string;
}

/**
 * 从一个填充节点取色：既接受容器（spPr / bgPr / rPr / a:ln），也接受填充标签本身
 * （主题 bgFillStyleLst 里直接就是 a:solidFill / a:gradFill）。
 * 只认自身和直接子节点，否则会误把 <a:ln> 里的描边色当成填充色。
 * 渐变只取第一个色标做近似，图片背景无法导入（没有可用 URL）。
 */
function resolveFill(node: XmlNode | undefined, ctx: StyleCtx, phClr: string | null): ResolvedFill {
  if (!node) return { kind: 'none', color: null };
  if (node.name === 'a:srgbClr' || node.name === 'a:schemeClr' || node.name === 'a:sysClr') {
    return { kind: 'solid', color: colorOfColorNode(node, ctx, phClr) };
  }

  const isOrHas = (tag: string) => (node.name === tag ? node : directChild(node, tag));
  const solid = isOrHas('a:solidFill');
  if (solid) return { kind: 'solid', color: colorOfColorNode(solid.children[0], ctx, phClr) };

  const grad = isOrHas('a:gradFill');
  if (grad) {
    const stops = directChild(grad, 'a:gsLst')?.children ?? [];
    return { kind: 'gradient', color: colorOfColorNode(stops[0]?.children[0], ctx, phClr) };
  }
  const blipFill = isOrHas('a:blipFill');
  if (blipFill) {
    const relId = directChild(blipFill, 'a:blip')?.attrs['r:embed'] ?? '';
    return { kind: 'image', color: null, relId: relId || undefined };
  }
  return { kind: 'none', color: null };
}

/** p:bg 里的 bgPr（直接给填充）与 bgRef（引用主题填充列表 + phClr 替换） */
function backgroundFromBg(
  bg: XmlNode | undefined,
  ctx: StyleCtx
): ResolvedFill {
  if (!bg) return { kind: 'none', color: null };
  const bgPr = directChild(bg, 'p:bgPr');
  if (bgPr) return resolveFill(bgPr, ctx, null);

  const bgRef = directChild(bg, 'p:bgRef');
  if (!bgRef) return { kind: 'none', color: null };
  const phClr = colorOfColorNode(bgRef.children[0], ctx, null);
  const idx = intAttr(bgRef.attrs, 'idx') ?? 0;
  if (ctx.theme && idx !== 0) {
    const list = idx >= 1000 ? ctx.theme.bgFillStyles : ctx.theme.fillStyles;
    const style = list[idx >= 1000 ? idx - 1001 : idx - 1];
    if (style) {
      const resolved = resolveFill(style, ctx, phClr);
      return resolved.color ? resolved : { kind: 'solid', color: phClr };
    }
  }
  return { kind: 'solid', color: phClr };
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 把形状的局部坐标，按祖先组合的 off/ext 与 chOff/chExt 线性映射到页面坐标 */
function resolveBox(shapeXfrm: XmlNode | undefined, groups: XmlNode[]): Box | null {
  if (!shapeXfrm) return null;
  const off = findFirst(shapeXfrm, 'a:off');
  const ext = findFirst(shapeXfrm, 'a:ext');
  if (!off || !ext) return null;

  let x = intAttr(off.attrs, 'x') ?? 0;
  let y = intAttr(off.attrs, 'y') ?? 0;
  let w = intAttr(ext.attrs, 'cx') ?? 0;
  let h = intAttr(ext.attrs, 'cy') ?? 0;

  for (const group of groups) {
    const gx = findFirst(group, 'a:xfrm');
    const gOff = gx ? findFirst(gx, 'a:off') : undefined;
    const gExt = gx ? findFirst(gx, 'a:ext') : undefined;
    const gChOff = gx ? findFirst(gx, 'a:chOff') : undefined;
    const gChExt = gx ? findFirst(gx, 'a:chExt') : undefined;
    if (!gOff || !gExt || !gChOff || !gChExt) continue;

    const ox = intAttr(gOff.attrs, 'x') ?? 0;
    const oy = intAttr(gOff.attrs, 'y') ?? 0;
    const cx = intAttr(gChOff.attrs, 'x') ?? 0;
    const cy = intAttr(gChOff.attrs, 'y') ?? 0;
    const scaleW = (intAttr(gExt.attrs, 'cx') ?? 1) / Math.max(1, intAttr(gChExt.attrs, 'cx') ?? 1);
    const scaleH = (intAttr(gExt.attrs, 'cy') ?? 1) / Math.max(1, intAttr(gChExt.attrs, 'cy') ?? 1);

    x = ox + (x - cx) * scaleW;
    y = oy + (y - cy) * scaleH;
    w *= scaleW;
    h *= scaleH;
  }

  return { x, y, w, h };
}

/** +mj-lt / +mn-ea 这类引用要落到主题的字族上 */
function resolveTypeface(raw: string, ctx: StyleCtx, prefer: 'latin' | 'ea'): string {
  const ref = raw.match(/^\+(mj|mn)-(lt|ea|cs)$/);
  if (ref && ctx.theme) {
    const fonts = ref[1] === 'mj' ? ctx.theme.major : ctx.theme.minor;
    return ref[2] === 'ea' ? fonts.ea : fonts.latin;
  }
  if (!raw) return ctx.theme ? (prefer === 'ea' ? ctx.theme.minor.ea : ctx.theme.minor.latin) : '';
  return raw;
}

/** latin 与 ea 拼成一条 CSS font-family：拉丁字形走 latin，缺字形的中文自动落到 ea */
function fontStack(rPr: XmlNode | undefined, ctx: StyleCtx): string | undefined {
  if (!rPr) return undefined;
  const latinNode = directChild(rPr, 'a:latin');
  const eaNode = directChild(rPr, 'a:ea');
  // 这一层没写字族就返回 undefined，否则会盖掉更深层的 +mj-lt / +mn-ea
  if (!latinNode && !eaNode) return undefined;
  const latin = resolveTypeface(latinNode?.attrs.typeface ?? '', ctx, 'latin');
  const ea = resolveTypeface(eaNode?.attrs.typeface ?? '', ctx, 'ea');
  const quoted = (name: string) => `"${name.replace(/["\\]/g, '').trim()}"`;
  const parts = [...new Set([latin, ea].filter((n) => n.trim()).map(quoted))];
  return parts.length ? parts.join(', ') : undefined;
}

interface StyleInfo {
  color: string | null;
  fontSize: number | null;
  /** null = 这一层没写；显式 b="0" 也要能盖掉更下层的 b="1" */
  bold: boolean | null;
  italic: boolean | null;
  fontFamily?: string;
}

function triState(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  return value === '1' || value === 'true';
}

/** 运行级样式：颜色 / 字号 / 粗斜体 / 字体。null 表示该属性继承自段落默认或版式，需要别处兜底 */
function runStyle(rPr: XmlNode | undefined, ctx: StyleCtx): StyleInfo {
  if (!rPr) return { color: null, fontSize: null, bold: null, italic: null };

  const sz = intAttr(rPr.attrs, 'sz');
  return {
    color: resolveFill(rPr, ctx, null).color,
    fontSize: sz ? Math.max(8, Math.min(400, Math.round((sz / 100) * PX_PER_PT))) : null,
    bold: triState(rPr.attrs.b),
    italic: triState(rPr.attrs.i),
    fontFamily: fontStack(rPr, ctx),
  };
}

/** PowerPoint 的继承顺序：run > 段落 defRPr > 形状 lstStyle > 母版/主题，逐字段兜底 */
function mergeStyle(primary: StyleInfo, fallback: StyleInfo): StyleInfo {
  return {
    color: primary.color ?? fallback.color,
    fontSize: primary.fontSize ?? fallback.fontSize,
    bold: primary.bold ?? fallback.bold,
    italic: primary.italic ?? fallback.italic,
    fontFamily: primary.fontFamily ?? fallback.fontFamily,
  };
}

const ALIGN_MAP: Record<string, TextBlock['textAlign']> = {
  l: 'left',
  ctr: 'center',
  c: 'center',
  r: 'right',
  just: 'left',
  dist: 'left',
};

const MAX_LEVELS = 9;

/** 一个 lvlNpPr 能提供的继承信息：段落对齐 + 该级默认字符样式 */
interface LvlStyle {
  defRPr: StyleInfo;
  align: TextBlock['textAlign'] | null;
}

const EMPTY_LVL: LvlStyle = {
  defRPr: { color: null, fontSize: null, bold: null, italic: null },
  align: null,
};

/** 按优先级从高到低逐层兜底，某一档缺失就跳过 */
function mergeLevels(layers: LvlStyle[][]): LvlStyle[] {
  return Array.from({ length: MAX_LEVELS }, (_, i) =>
    layers.reduceRight<LvlStyle>((lower, higher) => {
      const upper = higher[i];
      if (!upper) return lower;
      return {
        defRPr: mergeStyle(upper.defRPr, lower.defRPr),
        align: upper.align ?? lower.align,
      };
    }, EMPTY_LVL)
  );
}

function lstLevels(lstStyle: XmlNode | undefined, ctx: StyleCtx): LvlStyle[] {
  const out: LvlStyle[] = [];
  for (const child of lstStyle?.children ?? []) {
    const level = Number(child.name.match(/^a:lvl(\d)pPr$/)?.[1] ?? 0);
    if (!level || level > MAX_LEVELS) continue;
    out[level - 1] = {
      defRPr: runStyle(directChild(child, 'a:defRPr'), ctx),
      align: ALIGN_MAP[child.attrs.algn ?? ''] ?? null,
    };
  }
  return out;
}

/** p:ph@type 决定用母版 txStyles 的哪一档：标题、正文，其余（含无占位符的文本框）走 otherStyle */
function txStyleKind(phType: string | null): 'title' | 'body' | 'other' {
  if (!phType) return 'other';
  if (phType === 'title' || phType === 'ctrTitle') return 'title';
  if (phType === 'dt' || phType === 'ftr' || phType === 'sldNum') return 'other';
  return 'body';
}

interface PlaceholderRef {
  /** p:ph@type 原样，缺省为 null；由 resolvePlaceholder 结合 idx 推断，绝不无脑当 title */
  type: string | null;
  idx: string;
}

function findPh(sp: XmlNode): XmlNode | undefined {
  return findFirst(directChild(sp, 'p:nvSpPr'), 'p:ph');
}

/** 幻灯片形状上的占位符引用；type 保持缺省（null），真正的判定交给 resolvePlaceholder */
function placeholderRef(sp: XmlNode): PlaceholderRef | null {
  const ph = findPh(sp);
  if (!ph) return null;
  return { type: ph.attrs.type ?? null, idx: ph.attrs.idx ?? '' };
}

/** 按规范，p:ph@type 缺省就是 title；只有显式写了 type 或确定无 idx 时才这么认 */
function effectivePhType(type: string | null): string {
  return type ?? 'title';
}

/**
 * 解析一个形状的有效占位符 type。
 * 只有「有 idx 但没写 type」时才危险——很多模板把正文写成 `<p:ph idx="1"/>`，
 * 若按规范缺省当 title，正文就会套到 titleStyle（居中 + 超大字号）。
 * 这里回到版式/母版找 idx 相同的形状，用它的 type 校正；都推不出来时落到 body，绝不落到 title。
 */
function resolvePlaceholder(sp: XmlNode, ancestors: XmlNode[]): PlaceholderRef | null {
  const ref = placeholderRef(sp);
  if (!ref) return null;
  if (ref.type) return ref;
  if (!ref.idx || ref.idx === '0') return { ...ref, type: 'title' };

  for (const doc of ancestors) {
    for (const cand of findAll(doc, 'p:sp')) {
      const ph = findPh(cand);
      if (!ph || (ph.attrs.idx ?? '') !== ref.idx) continue;
      return { type: ph.attrs.type ?? 'body', idx: ref.idx };
    }
  }
  return { type: 'body', idx: ref.idx };
}

/** 版式/母版里同 idx（缺 idx 时同 type）的占位符形状，它的 lstStyle 就是幻灯片没写时的默认值 */
function placeholderLstLevels(doc: XmlNode, ref: PlaceholderRef, ctx: StyleCtx): LvlStyle[] {
  const refType = effectivePhType(ref.type);
  let fallback: LvlStyle[] = [];
  for (const sp of findAll(doc, 'p:sp')) {
    const ph = placeholderRef(sp);
    if (!ph) continue;
    const idxEqual = ref.idx !== '' && ph.idx !== '' && ph.idx === ref.idx;
    // idx 精确命中优先（即便候选省了 type）；否则要求有效 type 相同，不同则整个跳过
    if (!idxEqual && effectivePhType(ph.type) !== refType) continue;
    const levels = lstLevels(findFirst(directChild(sp, 'p:txBody'), 'a:lstStyle'), ctx);
    // 任一方缺 idx 时直接命中；两侧都有 idx 且相等也直接命中
    if (!ref.idx || !ph.idx || ph.idx === ref.idx) return levels;
    fallback = levels; // type 相同但 idx 不同（日期/页脚换 idx）：记为兜底
  }
  return fallback;
}

interface TxStyles {
  title: LvlStyle[];
  body: LvlStyle[];
  other: LvlStyle[];
}

/** 母版的 p:txStyles 是最底层的默认值：绝大多数幻灯片在这里才拿到文字颜色 */
function parseTxStyles(masterDoc: XmlNode | undefined, ctx: StyleCtx): TxStyles {
  const node = masterDoc ? findFirst(masterDoc, 'p:txStyles') : undefined;
  const of = (name: string) => lstLevels(node ? findFirst(node, `p:${name}`) : undefined, ctx);
  return { title: of('titleStyle'), body: of('bodyStyle'), other: of('otherStyle') };
}

/**
 * 一个形状每级段落能继承到的默认样式。
 * 优先级：形状 lstStyle > 版式占位符 > 母版占位符 > 母版 txStyles > 主题字色。
 * 少了这条链，源文件里没写颜色的文字就会全部落到兜底色（曾经导致白底白字）。
 */
function inheritedLevels(
  sp: XmlNode,
  ancestors: XmlNode[],
  txStyles: TxStyles,
  ctx: StyleCtx
): LvlStyle[] {
  const ref = resolvePlaceholder(sp, ancestors);
  const layers: LvlStyle[][] = [lstLevels(findFirst(directChild(sp, 'p:txBody'), 'a:lstStyle'), ctx)];
  for (const doc of ancestors) {
    layers.push(ref ? placeholderLstLevels(doc, ref, ctx) : []);
  }
  layers.push(txStyles[txStyleKind(ref?.type ?? null)]);
  return mergeLevels(layers);
}

function extractParagraphText(
  paragraph: XmlNode,
  ctx: StyleCtx,
  defaults: LvlStyle[]
): { text: string; style: StyleInfo; align: TextBlock['textAlign']; alignExplicit: boolean } {
  const pPr = directChild(paragraph, 'a:pPr');
  const level = Math.max(0, Math.min(MAX_LEVELS - 1, intAttr(pPr?.attrs ?? {}, 'lvl') ?? 0));
  const inherited = defaults[level] ?? EMPTY_LVL;
  const alignExplicit = ALIGN_MAP[pPr?.attrs.algn ?? ''] !== undefined;
  const align = ALIGN_MAP[pPr?.attrs.algn ?? ''] ?? inherited.align ?? 'left';
  const fallback = mergeStyle(runStyle(directChild(pPr, 'a:defRPr'), ctx), inherited.defRPr);

  let text = '';
  let style: StyleInfo | null = null;

  for (const child of paragraph.children) {
    if (child.name === 'a:r') {
      const runText = child.children.find((c) => c.name === 'a:t')?.text ?? '';
      text += runText;
      if (runText.trim() && !style) style = mergeStyle(runStyle(directChild(child, 'a:rPr'), ctx), fallback);
    } else if (child.name === 'a:br') {
      text += '\n';
    } else if (child.name === 'a:fld') {
      text += child.children.find((c) => c.name === 'a:t')?.text ?? '';
    }
  }

  return { text, style: style ?? fallback, align, alignExplicit };
}

type Paragraph = { align: TextBlock['textAlign']; alignExplicit: boolean };

function majorityAlign(items: Paragraph[], useExplicit: boolean): TextBlock['textAlign'] | null {
  const pool = useExplicit ? items.filter((p) => p.alignExplicit) : items;
  if (!pool.length) return null;
  const counts = new Map<TextBlock['textAlign'], { n: number; first: number }>();
  pool.forEach((p, i) => {
    const cur = counts.get(p.align);
    if (cur) cur.n++;
    else counts.set(p.align, { n: 1, first: i });
  });
  let best: TextBlock['textAlign'] | null = null;
  let bestCount = 0;
  let bestFirst = Infinity;
  for (const [align, { n, first }] of counts) {
    if (n > bestCount || (n === bestCount && first < bestFirst)) {
      best = align;
      bestCount = n;
      bestFirst = first;
    }
  }
  return best;
}

/** 一个块只有一种对齐，但 txBody 可能有多段：优先在显式写过 algn 的段落里取多数，全隐式才看全体 */
function pickBlockAlign(paragraphs: Paragraph[]): TextBlock['textAlign'] {
  return majorityAlign(paragraphs, true) ?? majorityAlign(paragraphs, false) ?? 'left';
}

/**
 * PowerPoint 的 normAutofit 会为了把文字塞进框而整体缩小字号，fontScale（百分数×1000，如 70000=0.7）
 * 就是这个缩放。不读它，导入后字号会比源文件大一截并溢出。spAutoFit（撑高框）与 noAutofit 返回 1。
 */
function autofitScale(sp: XmlNode): number {
  const bodyPr = findFirst(directChild(sp, 'p:txBody'), 'a:bodyPr');
  const normAutofit = bodyPr ? directChild(bodyPr, 'a:normAutofit') : undefined;
  const raw = normAutofit ? intAttr(normAutofit.attrs, 'fontScale') : null;
  if (raw === null) return 1;
  return Math.max(0.1, Math.min(1, raw / 100000));
}

/** 文本框外观：源文件里的形状填充、描边、圆角和 insets 都要落到块上 */
function shapeLook(
  sp: XmlNode,
  ctx: StyleCtx,
  boxPx: { w: number; h: number } | null
): Pick<TextBlock, 'bgColor' | 'bgOpacity' | 'borderColor' | 'borderWidth' | 'borderRadius' | 'padding' | 'wrap'> {
  const spPr = directChild(sp, 'p:spPr');
  const out: ReturnType<typeof shapeLook> = { bgOpacity: 1, padding: 4 };

  const fill = resolveFill(spPr, ctx, null);
  if (fill.color && fill.kind !== 'none') out.bgColor = fill.color;

  const ln = directChild(spPr, 'a:ln');
  if (ln) {
    const lineFill = resolveFill(ln, ctx, null);
    if (lineFill.color) {
      out.borderColor = lineFill.color;
      out.borderWidth = Math.max(1, Math.round((intAttr(ln.attrs, 'w') ?? 12700) / EMU_PER_PX));
    }
  }

  const geom = directChild(spPr, 'a:prstGeom');
  if (geom?.attrs.prst === 'roundRect' && boxPx) {
    // adj 是「短边的千分之几」，fmla 形如 "val 12000"；PowerPoint 缺省 16667
    const fmla = directChild(directChild(geom, 'a:avLst'), 'a:gd')?.attrs.fmla ?? '';
    const raw = Number(fmla.match(/val\s+(\d+)/)?.[1] ?? 16667);
    const ratio = Math.max(0, Math.min(0.5, (Number.isFinite(raw) ? raw : 16667) / 100000));
    out.borderRadius = Math.round(ratio * Math.min(boxPx.w, boxPx.h));
  }

  const bodyPr = findFirst(directChild(sp, 'p:txBody'), 'a:bodyPr');
  if (bodyPr) {
    // 块只有一个 CSS padding，但源文件有四个独立 inset；取最大值，避免纵向 inset 欠报把下缘裁掉
    const insets = ['lIns', 'tIns', 'rIns', 'bIns']
      .map((k) => intAttr(bodyPr.attrs, k))
      .filter((n): n is number => n !== null);
    if (insets.length) out.padding = Math.max(0, Math.round(Math.max(...insets) / EMU_PER_PX));
    if (bodyPr.attrs.wrap === 'none') out.wrap = false;
  }
  return out;
}

export function parseSlideSize(presentationXml: string | undefined): { cx: number; cy: number } {
  const defaults = { cx: 12192000, cy: 6858000 };
  if (!presentationXml) return defaults;
  const sldSz = findFirst(parseXml(presentationXml), 'p:sldSz');
  if (!sldSz) return defaults;
  const cx = intAttr(sldSz.attrs, 'cx');
  const cy = intAttr(sldSz.attrs, 'cy');
  if (!cx || !cy || cx <= 0 || cy <= 0) return defaults;
  return { cx, cy };
}

/**
 * pt 值用于兜底字号：1pt = 12700 EMU 不影响这里，只按框高粗算。
 * 多段/多行时把整框高摊到每一行，否则一段三行的框会被估成撑满整框的超大字号再溢出。
 */
function fallbackFontSize(boxHEmu: number, lines = 1): number {
  const pt = boxHEmu / EMU_PER_PT;
  return Math.max(12, Math.min(96, Math.round((pt * PX_PER_PT * 0.6) / Math.max(1, lines))));
}

/** 母版/版式/主题一路都没有颜色时，只能按页面底色取对比色，避免白底白字 */
function readableColorOn(background: string | null): string {
  const rgb = background ? hexToRgb(background) : null;
  if (!rgb) return '#ffffff';
  const luminance = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114;
  return luminance > 140 ? '#202020' : '#ffffff';
}

function dirOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/'));
}

function baseOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** ../slideLayouts/slideLayout7.xml 相对 ppt/slides/slide1.xml 归一成包内路径 */
function resolvePartPath(basePath: string, target: string): string {
  let t = target.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = dirOf(basePath).split('/');
  while (t.startsWith('../')) {
    segments.pop();
    t = t.slice(3);
  }
  t = t.replace(/^\.\//, '');
  return [...segments, t].filter((s) => s !== '.').join('/');
}

interface PartReader {
  raw: (path: string | undefined) => string | undefined;
  doc: (path: string | undefined) => XmlNode | null;
  rel: (fromPath: string, typeSuffix: string) => string | null;
  relById: (fromPath: string, relId: string) => string | null;
}

function createPartReader(parts: Record<string, string>): PartReader {
  const docs = new Map<string, XmlNode | null>();

  const doc = (path: string | undefined): XmlNode | null => {
    if (!path) return null;
    if (!docs.has(path)) {
      const xml = parts[path];
      docs.set(path, xml ? parseXml(xml) : null);
    }
    return docs.get(path) ?? null;
  };

  /** 某个部件的 *.rels 文档：slide→layout→master→theme 和图片 r:embed 都靠它 */
  const relsOf = (fromPath: string): XmlNode | null =>
    doc(`${dirOf(fromPath)}/_rels/${baseOf(fromPath)}.rels`);

  return {
    raw: (path) => (path ? parts[path] : undefined),
    doc,
    rel: (fromPath, typeSuffix) => {
      const rels = relsOf(fromPath);
      if (!rels) return null;
      for (const rel of findAll(rels, 'Relationship')) {
        if (rel.attrs.Type?.endsWith(typeSuffix) && rel.attrs.Target) {
          return resolvePartPath(fromPath, rel.attrs.Target);
        }
      }
      return null;
    },
    relById: (fromPath, relId) => {
      const rels = relsOf(fromPath);
      if (!rels) return null;
      const target = findAll(rels, 'Relationship').find((rel) => rel.attrs.Id === relId)?.attrs.Target;
      return target ? resolvePartPath(fromPath, target) : null;
    },
  };
}

interface SlideStyleSources {
  ctx: StyleCtx;
  /** 版式 + 母版的文档，按优先级排列，用于背景与占位符样式继承 */
  masters: XmlNode[];
  /** 与 masters 一一对应的部件路径，图片背景要靠各自的 .rels 解析 r:embed */
  masterPaths: string[];
  txStyles: TxStyles;
}

/** 幻灯片自己几乎不带 p:bg，母版和主题才决定页面底色 */
function resolveStyleSources(slidePath: string, reader: PartReader): SlideStyleSources {
  const layoutPath = reader.rel(slidePath, '/slideLayout');
  const masterPath =
    (layoutPath ? reader.rel(layoutPath, '/slideMaster') : null) ??
    reader.rel(slidePath, '/slideMaster') ??
    'ppt/slideMasters/slideMaster1.xml';
  const themePath = reader.rel(masterPath, '/theme') ?? 'ppt/theme/theme1.xml';

  const ctx: StyleCtx = { theme: parseTheme(reader.raw(themePath)), clrMap: parseClrMap(reader.raw(masterPath)) };
  const entries = layoutPath
    ? [
        { path: layoutPath, doc: reader.doc(layoutPath) },
        { path: masterPath, doc: reader.doc(masterPath) },
      ]
    : [{ path: masterPath, doc: reader.doc(masterPath) }];
  const found = entries.filter((e): e is { path: string; doc: XmlNode } => !!e.doc);
  const masterDoc = found.length ? found[found.length - 1].doc : undefined;

  return {
    ctx,
    masters: found.map((e) => e.doc),
    masterPaths: found.map((e) => e.path),
    txStyles: parseTxStyles(masterDoc, ctx),
  };
}

interface ApproxTally {
  gradient: number;
  image: number;
}

interface ResolvedBackground {
  /** 纯色兜底：图片背景取不到时也能用 */
  color: string | null;
  /** p:bg 用的是图片时，指向包内媒体部件路径 */
  imagePart: string | null;
}

/** 页面底色：幻灯片自己的 p:bg 优先，其次版式、母版，最后主题 bg1 */
function slideBackground(
  slidePath: string,
  cSld: XmlNode | undefined,
  sources: SlideStyleSources,
  tally: ApproxTally,
  reader: PartReader
): ResolvedBackground {
  const { ctx, masters, masterPaths } = sources;
  const chain: { node: XmlNode | undefined; path: string }[] = [
    { node: cSld, path: slidePath },
    ...masters.map((doc, i) => ({ node: doc as XmlNode | undefined, path: masterPaths[i] ?? slidePath })),
  ];

  const saw = { gradient: false, image: false };
  let imagePart: string | null = null;

  for (const { node, path } of chain) {
    // 版式/母版的 p:bg 挂在它们各自的 p:cSld 上，且外层可能还包着 #root
    const holder = node?.name === 'p:cSld' ? node : findFirst(node, 'p:cSld');
    const bg = holder ? directChild(holder, 'p:bg') : undefined;
    if (!bg) continue;
    const fill = backgroundFromBg(bg, ctx);
    if (fill.kind === 'gradient' && !saw.gradient) {
      saw.gradient = true;
      tally.gradient++;
    }
    if (fill.kind === 'image') {
      // 图片背景记下部件，同时继续往下层找纯色兜底
      if (!saw.image) {
        saw.image = true;
        tally.image++;
        imagePart = fill.relId ? reader.relById(path, fill.relId) : null;
      }
      continue;
    }
    if (fill.color) return { color: fill.color, imagePart };
  }
  return { color: ctx.theme ? resolveSchemeColor('bg1', ctx, null) : null, imagePart };
}

/** 整页大图（第一层形状 + 覆盖 ≥80% 页面）实际上就是背景，不是内容 */
function fullBleedPicturePart(
  spTree: XmlNode | undefined,
  size: { cx: number; cy: number },
  slidePath: string,
  reader: PartReader
): string | null {
  if (!spTree) return null;
  const shapes = spTree.children.filter((c) =>
    ['p:sp', 'p:pic', 'p:grpSp', 'p:graphicFrame'].includes(c.name)
  );
  const first = shapes[0];
  if (first?.name !== 'p:pic') return null;

  const box = resolveBox(findFirst(directChild(first, 'p:spPr'), 'a:xfrm'), []);
  if (!box) return null;
  const ratio = (box.w * box.h) / (size.cx * size.cy);
  if (ratio < 0.8) return null;

  const relId = findFirst(first, 'a:blip')?.attrs['r:embed'] ?? '';
  return relId ? reader.relById(slidePath, relId) : null;
}

/**
 * 正文 p:pic → 待解析槽位，几何与文字块走同一套 resolveBox（含所在组的缩放换算）。
 *
 * fit 默认 'fill'：pptx 的图片默认就是按 a:stretch 拉满自己的框，照搬才不走样；
 * 带 a:srcRect 的图在源文件里被裁过，模型里没有裁剪，按 'cover' 比拉伸更接近看到的样子。
 * 旋转/翻转/平铺都放不下，只能近似并计数，导入完在顶部写清楚。
 */
function pictureSlot(
  node: XmlNode,
  slideId: string,
  slidePath: string,
  size: { cx: number; cy: number },
  groups: XmlNode[],
  zIndex: number,
  reader: PartReader,
  approx: PictureApprox
): ImageSlot | null {
  const spPr = directChild(node, 'p:spPr');
  const xfrm = spPr ? findFirst(spPr, 'a:xfrm') : undefined;
  const box = resolveBox(xfrm, groups);
  const relId = findFirst(node, 'a:blip')?.attrs['r:embed'] ?? '';
  const part = relId ? reader.relById(slidePath, relId) : null;
  if (!box || !part || box.w <= 0 || box.h <= 0) return null;

  const blipFill = directChild(node, 'p:blipFill');
  let fit: ImageFit = 'fill';
  if (findFirst(blipFill, 'a:srcRect')) {
    fit = 'cover';
    approx.cropped++;
  } else if (findFirst(blipFill, 'a:tile')) {
    approx.tiled++;
  }
  if (xfrm && (intAttr(xfrm.attrs, 'rot') || intAttr(xfrm.attrs, 'flipH') || intAttr(xfrm.attrs, 'flipV'))) {
    approx.rotated++;
  }

  return {
    slideId,
    part,
    x: clampPct(box.x, size.cx),
    y: clampPct(box.y, size.cy),
    width: clampPct(box.w, size.cx) || 60,
    height: Math.max(1, clampPct(box.h, size.cy)),
    fit,
    alt: findFirst(node, 'p:cNvPr')?.attrs.descr?.trim() || baseOf(part),
    zIndex,
  };
}

export function importSlides(sources: PptxSlideSource[], options: PptxImportOptions = {}): ImportReport {
  const size = parseSlideSize(options.presentationXml);
  const reader = createPartReader(options.parts ?? {});
  const skipped = { pictures: 0, videos: 0, charts: 0 };
  const warnings: string[] = [];
  const slides: Slide[] = [];
  const imageBackgrounds: ImageBackgroundRef[] = [];
  const imageSlots: ImageSlot[] = [];
  const pictureApprox: PictureApprox = { cropped: 0, rotated: 0, tiled: 0 };
  const approx = { gradient: 0, image: 0 };

  for (const source of sources) {
    const doc = parseXml(source.xml);
    const cSld = findFirst(doc, 'p:cSld');
    const spTree = findFirst(doc, 'p:spTree');
    const sources_ = resolveStyleSources(source.path, reader);
    const { ctx, masters, txStyles } = sources_;
    const slideId = crypto.randomUUID();

    const pictures = findAll(doc, 'p:pic');
    skipped.pictures += pictures.length;
    skipped.videos += findAll(doc, 'p:videoFile').length + findAll(doc, 'a:videoFile').length;
    skipped.charts += findAll(doc, 'p:graphicFrame').length;

    let background = slideBackground(source.path, cSld, sources_, approx, reader);
    if (!background.imagePart && pictures.length) {
      // 很多讲道稿把整页照片当成第一个形状铺底，而不是写在 p:bg 里
      const part = fullBleedPicturePart(spTree, size, source.path, reader);
      if (part) {
        background = { ...background, imagePart: part };
        approx.image++;
        skipped.pictures--;
      }
    }
    if (background.imagePart) imageBackgrounds.push({ slideId, part: background.imagePart });

    const fallbackColor = background.color ?? '#1a1a2e';
    const textBlocks: TextBlock[] = [];
    const slideSlotsStart = imageSlots.length;

    /** 某个 p:pic 引用到包里的哪个媒体部件；关系 id 查不到就是空 */
    const picPart = (node: XmlNode): string | null =>
      reader.relById(source.path, findFirst(node, 'a:blip')?.attrs['r:embed'] ?? '');

    /** 层叠计数器：文字与图片共用，谁先在形状树里出现谁在下 */
    const nextZ = () => textBlocks.length + (imageSlots.length - slideSlotsStart) + 1;

    walk(spTree ?? doc, (node, chain) => {
      const groups = chain.filter((n) => n.name === 'p:grpSp');

      if (node.name === 'p:pic') {
        // 已经当成整页底图吃掉的那张不重复抽成正文块：底图本来就铺满页面
        if (background.imagePart && picPart(node) === background.imagePart) return;
        const slot = pictureSlot(
          node,
          slideId,
          source.path,
          size,
          groups,
          nextZ(),
          reader,
          pictureApprox
        );
        if (slot) imageSlots.push(slot);
        return;
      }

      if (node.name !== 'p:sp') return;

      const txBody = directChild(node, 'p:txBody');
      if (!txBody) return;

      const spPr = directChild(node, 'p:spPr');
      const box = resolveBox(spPr ? findFirst(spPr, 'a:xfrm') : undefined, groups);

      const defaults = inheritedLevels(node, masters, txStyles, ctx);
      const paragraphs = findAll(txBody, 'a:p')
        .map((p) => extractParagraphText(p, ctx, defaults))
        .filter((p) => p.text.trim().length > 0);

      // 没有文字但有填充/描边的形状是文字的底板，丢掉会让白字直接落在页面底色上
      if (paragraphs.length === 0) {
        if (!box) return;
        const look = shapeLook(node, ctx, { w: box.w / EMU_PER_PX, h: box.h / EMU_PER_PX });
        if (!look.bgColor && !look.borderColor) return;
        textBlocks.push({
          id: crypto.randomUUID(),
          text: '',
          x: clampPct(box.x, size.cx),
          y: clampPct(box.y, size.cy),
          width: clampPct(box.w, size.cx) || 60,
          height: Math.max(1, clampPct(box.h, size.cy)),
          fontSize: 24,
          color: fallbackColor,
          fontWeight: 'normal',
          fontStyle: 'normal',
          textAlign: 'left',
          ...look,
          zIndex: nextZ(),
        });
        return;
      }

      const text = paragraphs.map((p) => p.text).join('\n');
      const lead = paragraphs[0].style;
      const lines = paragraphs.reduce((n, p) => n + p.text.split('\n').length, 0);
      const scale = autofitScale(node);

      const heightPct = box
        ? Math.max(2, clampPct(box.h, size.cy))
        : Math.max(8, Math.min(30, paragraphs.length * 8));
      const rawFontSize = lead.fontSize ?? fallbackFontSize((heightPct / 100) * size.cy, lines);
      const fontSize = Math.max(8, Math.min(400, Math.round(rawFontSize * scale)));

      const style: Omit<TextBlock, 'id' | 'text' | 'x' | 'y' | 'width' | 'height'> = {
        fontSize,
        color: lead.color ?? readableColorOn(background.color),
        fontWeight: (lead.bold ? 'bold' : 'normal') as TextBlock['fontWeight'],
        fontStyle: (lead.italic ? 'italic' : 'normal') as TextBlock['fontStyle'],
        textAlign: pickBlockAlign(paragraphs),
        fontFamily: lead.fontFamily,
        ...shapeLook(node, ctx, box ? { w: box.w / EMU_PER_PX, h: box.h / EMU_PER_PX } : null),
        zIndex: nextZ(),
      };

      if (box) {
        textBlocks.push({
          id: crypto.randomUUID(),
          text,
          x: clampPct(box.x, size.cx),
          y: clampPct(box.y, size.cy),
          width: clampPct(box.w, size.cx) || 60,
          height: heightPct,
          ...style,
        });
      } else {
        // 位置继承自版式/母版，这里拿不到 —— 退化为居中堆叠，并提示用户手动微调
        textBlocks.push({
          id: crypto.randomUUID(),
          text,
          x: 10,
          y: Math.min(90, 20 + textBlocks.length * 14),
          width: 80,
          height: heightPct,
          ...style,
        });
      }
    });

    skipped.pictures -= imageSlots.length - slideSlotsStart;

    if (textBlocks.length === 0) {
      warnings.push(`${source.path}：没有可导入的文字（文字可能位于母版，或这页本来就没字）`);
    }

    slides.push({
      id: slideId,
      background: { type: 'color', value: fallbackColor },
      textBlocks,
      // 正文图片在 imageSlots 里等来源解析，调用方按 slideId 把 imageBlocks 填上
      imageBlocks: [],
      videoBlocks: [],
    });
  }

  if (approx.gradient) warnings.push(`${approx.gradient} 页是渐变背景，已按渐变起始色近似成纯色`);
  if (skipped.pictures) {
    warnings.push(`${skipped.pictures} 张图片没带位置或引用不到包里的文件，只能丢掉`);
  }
  if (pictureApprox.cropped) {
    warnings.push(`${pictureApprox.cropped} 张图片在源文件里被裁过，这里按裁满框显示，需要手动重新选一次`);
  }
  if (pictureApprox.rotated) {
    warnings.push(`${pictureApprox.rotated} 张图片带旋转或翻转，导入后按水平摆放`);
  }
  if (pictureApprox.tiled) {
    warnings.push(`${pictureApprox.tiled} 张图片是平铺填充，导入后按拉伸显示`);
  }
  if (skipped.videos) warnings.push(`共跳过 ${skipped.videos} 个视频`);
  if (skipped.charts) warnings.push(`共跳过 ${skipped.charts} 个图表/SmartArt`);

  return { slides, skipped, imageBackgrounds, imageSlots, pictureApprox, warnings };
}
