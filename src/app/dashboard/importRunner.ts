'use client';

/**
 * .pptx 导入的执行体：全程在浏览器里解压、抽图、存图，最后只把这份 deck 交给 POST /api/presentations。
 * 字节不过服务器 —— Vercel 的函数既没有可写磁盘，也塞不下几十 MB 的包，
 * 而 deck 的最终裁决仍在服务端（配额 + serializeSlides），前端只负责提前估一遍少走弯路。
 */
import { MAX_IMPORT_FILE_BYTES } from '@/lib/media-ext';
import { hasMediaBase } from '@/lib/media-source';
import type { ImportProgress } from '@/lib/pptx-import';

export interface PptxImportOptions {
  /** 抽出来的图片是否传云端；取消勾选就只进本机素材库 */
  cloud: boolean;
  setImportNotice: (notice: { id: number; warnings: string[] }) => void;
  push: (path: string) => void;
  onProgress?: (label: string) => void;
}

function progressLabel(p: ImportProgress, cloud: boolean): string {
  switch (p.phase) {
    case 'unpack':
      return '解析中…';
    case 'media':
      return `${cloud ? '传图' : '存图'} ${p.done}/${p.total}`;
    default:
      return '整理中…';
  }
}

/** 图片落到哪，用户得知道：云端失败退回本机、以及本来就没勾云端，是两件不同的事 */
function sinkWarnings(stats: { cloudFallback: number; localStored: number }, cloud: boolean): string[] {
  const lines: string[] = [];
  if (stats.cloudFallback) {
    lines.push(`${stats.cloudFallback} 张图片云端没存进去，已改存本机素材库（换设备后这些图看不到）`);
  }
  if (!cloud && stats.localStored) {
    lines.push(`按「不传云端」导入：${stats.localStored} 张图片只存在这台电脑的这个浏览器里`);
  }
  return lines;
}

type PptxPipeline = [typeof import('@/lib/pptx-import'), typeof import('@/lib/pptxSink')];

let pipeline: Promise<PptxPipeline> | null = null;

/**
 * 解压整条链（jszip + pptx 解析 + 图片落地）只在这位用户真的要导入时才需要，
 * 静态 import 会把它焊进 /dashboard 的首屏 chunk：90KB 代码，为从不点导入的人下载。
 */
export function loadPptxPipeline(): Promise<PptxPipeline> {
  if (!pipeline) {
    pipeline = Promise.all([import('@/lib/pptx-import'), import('@/lib/pptxSink')]);
    // 网络抖一下不该永久卡死：失败就丢缓存，下次点重新拉
    void pipeline.catch(() => {
      pipeline = null;
    });
  }
  return pipeline;
}

export async function runPptxImport(file: File, opts: PptxImportOptions): Promise<void> {
  if (!file.name.toLowerCase().endsWith('.pptx')) throw new Error('只支持 .pptx 格式');
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    throw new Error(`文件过大（最大 ${Math.round(MAX_IMPORT_FILE_BYTES / 1024 / 1024)}MB）`);
  }

  // 云端公开读没配 → 传上去也渲染不出来，直接按本机处理（界面上这个勾选框也已经是禁用态）
  const cloud = opts.cloud && hasMediaBase();
  const warnLeave = (e: BeforeUnloadEvent) => {
    e.preventDefault();
    e.returnValue = '';
  };
  window.addEventListener('beforeunload', warnLeave);

  try {
    opts.onProgress?.('准备导入组件…');
    const [{ importPptx }, { createMediaResolver }] = await loadPptxPipeline();
    const sink = createMediaResolver({ cloud });
    const out = await importPptx({
      data: file,
      resolveMedia: sink.resolveMedia,
      onProgress: (p) => opts.onProgress?.(progressLabel(p, cloud)),
    });

    opts.onProgress?.('保存中…');
    const title = file.name.replace(/\.pptx$/i, '').trim().slice(0, 100) || '导入的演示文稿';
    const res = await fetch('/api/presentations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, data: out.slides }),
    });
    const json = (await res.json().catch(() => null)) as { id?: number; error?: string } | null;
    if (!res.ok || typeof json?.id !== 'number') {
      // 服务端的原因（配额、内容超限、页数超限）原样转达，别再包一层「导入失败」把它糊掉
      throw new Error(json?.error || `保存失败（HTTP ${res.status}）`);
    }

    const warnings = [...out.warnings, ...sinkWarnings(sink.stats, cloud)];
    if (warnings.length) opts.setImportNotice({ id: json.id, warnings });
    opts.push(`/editor/${json.id}`);
  } finally {
    window.removeEventListener('beforeunload', warnLeave);
  }
}
