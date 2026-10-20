/**
 * 在浏览器里把 .pptx（本质是一个 zip 包）摊平成解析层要吃的形状。
 *
 * 整包只交给 JSZip 一次，XML 部件读成字符串，媒体字节按需惰性取——
 * 于是一个 200MB 的课件不会先变成一坨内存里的字符串，
 * 也不必经过我们的服务器（Vercel 的函数请求体只有几 MB，也没有可写的磁盘）。
 */
import JSZip from 'jszip';
import { MAX_SLIDES } from './slide-data.ts';
import type { PptxSlideSource } from './pptx.ts';

/** JSZip 三种收得下的输入：浏览器选中的 File、读出来的 ArrayBuffer 或一段字节 */
export type PptxPackageData = Blob | ArrayBuffer | Uint8Array;

export interface PptxPackage {
  /** 按页码排好的幻灯片；页数超过上限时只留前 MAX_SLIDES 页 */
  sources: PptxSlideSource[];
  /** 版式/母版/主题与所有关系表，解析层靠它们继承背景、字号和图片指向 */
  parts: Record<string, string>;
  presentationXml?: string;
  /** 包里真实的页数，sources 可能比它少 */
  slideCount: number;
  truncated: boolean;
  /** 取包内某个媒体部件的原始字节；不是 ppt/media 下的部件或文件不存在都返回 null */
  readMedia: (part: string) => Promise<Uint8Array<ArrayBuffer> | null>;
}

const SLIDE_PART = /^ppt\/slides\/slide(\d+)\.xml$/;
/** 主题、母版、版式的 xml；幻灯片自己的 xml 走 sources，不重复读一遍 */
const STYLE_XML_PART = /^ppt\/(?:theme|slideMasters|slideLayouts)\/[^/]+\.xml$/;
/** 所有 *_rels/*.rels：slide→layout→master→theme 的关系链和图片的 r:embed 都靠它 */
const RELS_PART = /^ppt\/(?:.*\/)?_rels\/[^/]+\.rels$/;

function slideNumberOf(path: string): number {
  return Number(path.match(SLIDE_PART)?.[1] ?? 0);
}

export async function unpackPptx(data: PptxPackageData): Promise<PptxPackage> {
  const zip = await JSZip.loadAsync(data);

  const slidePaths = Object.values(zip.files)
    .filter((entry) => !entry.dir && SLIDE_PART.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => slideNumberOf(a) - slideNumberOf(b));

  if (slidePaths.length === 0) throw new Error('这个 .pptx 里没有任何幻灯片');

  const truncated = slidePaths.length > MAX_SLIDES;
  const kept = truncated ? slidePaths.slice(0, MAX_SLIDES) : slidePaths;

  const sources: PptxSlideSource[] = [];
  for (const path of kept) {
    const entry = zip.file(path);
    if (entry) sources.push({ path, xml: await entry.async('string') });
  }

  const parts: Record<string, string> = {};
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    if (STYLE_XML_PART.test(entry.name) || RELS_PART.test(entry.name)) {
      parts[entry.name] = await entry.async('string');
    }
  }

  const presentationEntry = zip.file('ppt/presentation.xml');
  const presentationXml = presentationEntry ? await presentationEntry.async('string') : undefined;

  return {
    sources,
    parts,
    presentationXml,
    slideCount: slidePaths.length,
    truncated,
    // 只认 ppt/media 下的部件：关系表里写了别的路径也不顺着读，避免把 xml 当图片字节交出去
    readMedia: async (part: string) => {
      if (!/^ppt\/media\/[^/]+$/.test(part)) return null;
      const entry = zip.file(part);
      // JSZip 解压出来的永远是「独立 ArrayBuffer + 整段视图」，它自己的类型却写成宽泛的 Uint8Array
      return entry ? ((await entry.async('uint8array')) as Uint8Array<ArrayBuffer>) : null;
    },
  };
}
