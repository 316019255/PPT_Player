'use client';

/* eslint-disable @next/next/no-img-element -- 预览图是 IndexedDB 里 Blob 的 blob: URL，next/image 不解这类源，也没有可配的 remotePatterns */
import { useRef } from 'react';
import {
  formatBytes,
  useLocalThumb,
  type LocalMaterialMeta,
  type LocalThumbResult,
} from '@/lib/localMaterials';
import { useInView } from '@/components/useInView';

/** 没预览时格子里显示什么：还没滚到/还在读=转圈，老素材没预览图，记录已删 */
export function tilePlaceholder(inView: boolean, status: LocalThumbResult['status']): { text: string; tip?: string } {
  if (!inView || status === 'pending') return { text: '⏳' };
  if (status === 'blank') return { text: '无预览', tip: '这个素材是在预览功能之前导入的，重新添加一次就有预览了' };
  if (status === 'missing') return { text: '已删除', tip: '文件已不在本机浏览器里' };
  return { text: '⏳' };
}

/**
 * 本地素材格子：只显示导入时生成的那张小预览，绝不解码原文件。
 * 这条是硬规矩——一屏几十格同时解原图会把浏览器打趴，改这里之前先确认自己是在省内存不是在省代码。
 */
export function MaterialThumb({
  meta,
  onPick,
  onRemove,
  grid = false,
}: {
  meta: LocalMaterialMeta;
  onPick: () => void;
  onRemove: () => void;
  /** 两列竖向网格按列宽定高；横滚那条的高度来自它自己那 100px，只能 h-full */
  grid?: boolean;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const inView = useInView(boxRef);
  const thumb = useLocalThumb(inView ? meta.key : '');
  const url = thumb.status === 'ready' ? thumb.url : '';
  const { text: placeholder, tip: placeholderTip } = tilePlaceholder(inView, thumb.status);

  return (
    <div className={`relative aspect-video ${grid ? 'w-full' : 'h-full shrink-0'}`} ref={boxRef}>
      <button
        onClick={onPick}
        className="w-full h-full rounded overflow-hidden border border-white/10 hover:border-green-500 transition relative bg-black"
        title={`${meta.name} · ${formatBytes(meta.size)}`}
      >
        {url ? (
          <>
            <img src={url} alt={meta.name} className="w-full h-full object-cover" decoding="async" />
            {meta.kind === 'video' && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                <span className="text-lg">▶</span>
              </div>
            )}
          </>
        ) : (
          <div
            className="w-full h-full flex items-center justify-center text-[10px] text-gray-500"
            title={placeholderTip}
          >
            {placeholder}
          </div>
        )}
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        title="从本地库删除"
        className="absolute top-1 right-1 w-6 h-6 rounded bg-black/70 hover:bg-red-600 text-white text-xs flex items-center justify-center transition"
      >
        🗑
      </button>
    </div>
  );
}
