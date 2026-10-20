'use client';

import type { ImageBlock } from '@/types/ppt';
import { imageBlockStyle } from '@/components/blockStyle';
import { ImageFrame, useResolvedSrc } from '@/components/ImageBlockView';
import { useBlockDrag } from '@/components/useBlockDrag';
import type { HandlePos } from '@/lib/block-geometry';
import { useCompactEditor } from '@/components/useCompactEditor';

interface Props {
  block: ImageBlock;
  selected: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onSelect: (id: string) => void;
  onUpdate: (updates: Partial<ImageBlock>) => void;
  onDelete: () => void;
}

/**
 * 编辑器里的图片块：和文字块共用同一套拖拽/手柄几何，
 * 但缺素材时必须留下一块能点、能删的框 —— 隐身等于「没有」。
 */
export function ImageBlockRenderer({ block, selected, containerRef, onSelect, onUpdate, onDelete }: Props) {
  const compact = useCompactEditor();
  const { startDrag, handleStyle } = useBlockDrag({
    block,
    selected,
    containerRef,
    onSelect: () => onSelect(block.id),
    onUpdate,
    onDelete,
  });

  const resolved = useResolvedSrc(block.src, false, 'image');
  const hint = resolved.status === 'pending' ? '' : missingHint(block, resolved);

  return (
    <div
      style={imageBlockStyle(block, { interactive: true, selected })}
      onPointerDown={(e) => startDrag('move', e)}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(block.id);
      }}
    >
      {resolved.status === 'ready' ? (
        <ImageFrame url={resolved.url} fit={block.fit} alt={block.alt} />
      ) : hint ? (
        <div
          className="w-full h-full flex items-center justify-center text-center px-2 rounded bg-white/5 border border-dashed border-yellow-500/50 text-yellow-300 text-sm leading-snug"
          title={resolved.status === 'error' ? resolved.reason : undefined}
        >
          {hint}
        </div>
      ) : null}

      {selected &&
        !compact &&
        (['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as HandlePos[]).map((pos) => (
          <div key={pos} style={handleStyle(pos)} onPointerDown={(e) => startDrag(pos, e)} />
        ))}
    </div>
  );
}

/** 一句话说明为什么现在看不到图，以及怎么补救；放映页不调用这里 */
function missingHint(block: ImageBlock, resolved: { status: string; reason?: string }): string {
  if (resolved.status === 'error') return '本地素材读取失败';
  if (block.src.kind === 'cloud') return '云端图片地址未配置';
  if (block.src.kind === 'local') return '这台设备没有这张图';
  return '图片加载失败';
}
