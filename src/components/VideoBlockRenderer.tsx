'use client';

import type { VideoBlock } from '@/types/ppt';
import { videoBlockStyle } from '@/components/blockStyle';
import { VideoFrame } from '@/components/VideoBlockView';
import { useResolvedSrc } from '@/components/ImageBlockView';
import { useBlockDrag } from '@/components/useBlockDrag';
import type { HandlePos } from '@/lib/block-geometry';
import { useCompactEditor } from '@/components/useCompactEditor';

interface Props {
  block: VideoBlock;
  selected: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onSelect: (id: string) => void;
  onUpdate: (updates: Partial<VideoBlock>) => void;
  onDelete: () => void;
}

/**
 * 编辑器里的视频块：和图片块共用同一套拖拽/手柄几何。
 * 编辑器内不自动播放、不显示控件 —— 预览只靠 metadata 首帧。
 */
export function VideoBlockRenderer({ block, selected, containerRef, onSelect, onUpdate, onDelete }: Props) {
  const compact = useCompactEditor();
  const { startDrag, handleStyle } = useBlockDrag({
    block,
    selected,
    containerRef,
    onSelect: () => onSelect(block.id),
    onUpdate,
    onDelete,
  });

  const resolved = useResolvedSrc(block.src, false, 'video');
  const hint = resolved.status === 'pending' ? '' : missingHint(block, resolved);

  return (
    <div
      style={videoBlockStyle(block, { interactive: true, selected })}
      onPointerDown={(e) => startDrag('move', e)}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(block.id);
      }}
    >
      {resolved.status === 'ready' ? (
        <div style={{ pointerEvents: 'none', width: '100%', height: '100%' }}>
          <VideoFrame
            url={resolved.url}
            fit={block.fit}
            alt={block.alt}
            animate={false}
            loop={block.loop ?? false}
            muted={block.muted !== false}
            controls={false}
          />
        </div>
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

function missingHint(block: VideoBlock, resolved: { status: string; reason?: string }): string {
  if (resolved.status === 'error') return '本地素材读取失败';
  if (block.src.kind === 'cloud') return '云端视频地址未配置';
  if (block.src.kind === 'local') return '这台设备没有这个视频';
  return '视频加载失败';
}
