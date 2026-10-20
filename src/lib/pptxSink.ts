/**
 * 从 .pptx 里抽出来的图片字节，在浏览器里落到哪里。
 *
 * 默认传云端桶（换设备也看得到）；云端没收（超过单张上限、算不出指纹、网络断了）就退回本机 IndexedDB，
 * 这份 deck 照样存得下来，只是那几张图出了这台电脑就看不见 —— 落回本机的张数记在 stats 里，
 * 由导入执行体写进告警，别让用户以为导入结果和源文件一样。
 */
import { mimeForExt, sniffImageMime, storedImageExt } from './media-ext.ts';
import { createMaterialDupTable, localRefValue, putMaterial, type MaterialDupTable } from './localMaterials.ts';
import { uploadImageToCloud } from './mediaClient.ts';
import type { MediaResolution, MediaResolver } from './pptx-import.ts';

export interface PptxSinkStats {
  /** 本来要传云端、最后只落到本机库的张数（换设备就看不到这些） */
  cloudFallback: number;
  /** 按取消勾选直接只存本机的张数 */
  localStored: number;
}

export function createMediaResolver(opts: { cloud: boolean }): {
  resolveMedia: MediaResolver;
  stats: PptxSinkStats;
} {
  const stats: PptxSinkStats = { cloudFallback: 0, localStored: 0 };

  // 整份 pptx 共用一趟全库查重读：100 张图各自扫一遍库的话，耗时随库大小平方增长。
  // 只有真要落本机时才建表（全云端导入一次都不该读库）。
  let dup: Promise<MaterialDupTable> | null = null;
  const dupTable = (): Promise<MaterialDupTable> => {
    if (!dup) {
      const opening = createMaterialDupTable();
      // 建表失败不能把这个坏 promise 留下，否则整份导入后面每张图都继承同一个错误
      opening.catch(() => {
        if (dup === opening) dup = null;
      });
      dup = opening;
    }
    return dup;
  };

  const storeLocal = async (part: string, bytes: Uint8Array<ArrayBuffer>, mime: string): Promise<MediaResolution> => {
    // 保留包内文件名：本地素材库的列表靠它辨认这张图是 pptx 里的哪一张
    const name = part.split('/').pop() ?? 'image';
    try {
      const meta = await putMaterial(new File([bytes], name, { type: mime }), await dupTable());
      return { ok: true, src: { kind: 'local', value: localRefValue(meta.key) } };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : '本机素材库存不进去' };
    }
  };

  const resolveMedia: MediaResolver = async (part, bytes) => {
    const ext = storedImageExt(part);
    if (!ext) return { ok: false, reason: '这种格式浏览器画不出来' };
    // 以真实字节为准：包里的后缀可能是 .jpg 却装着 PNG
    const mime = sniffImageMime(bytes.subarray(0, 16)) ?? mimeForExt(ext) ?? 'image/png';

    if (opts.cloud) {
      const uploaded = await uploadImageToCloud(new Blob([bytes], { type: mime }));
      if (uploaded.ok) return { ok: true, src: { kind: 'cloud', value: uploaded.path } };
      const local = await storeLocal(part, bytes, mime);
      if (local.ok) stats.cloudFallback++;
      return local;
    }

    const local = await storeLocal(part, bytes, mime);
    if (local.ok) stats.localStored++;
    return local;
  };

  return { resolveMedia, stats };
}
