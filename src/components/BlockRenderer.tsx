'use client';

import { TextBlock } from '@/types/ppt';
import { blockStyle } from '@/components/blockStyle';
import { useBlockDrag } from '@/components/useBlockDrag';
import type { HandlePos } from '@/lib/block-geometry';
import { useCompactEditor } from '@/components/useCompactEditor';

interface Props {
  block: TextBlock;
  selected: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onSelect: (id: string) => void;
  onUpdate: (updates: Partial<TextBlock>) => void;
  onDelete: () => void;
}

export function BlockRenderer({ block, selected, containerRef, onSelect, onUpdate, onDelete }: Props) {
  const compact = useCompactEditor();
  const { startDrag, handleStyle } = useBlockDrag({
    block,
    selected,
    containerRef,
    onSelect: () => onSelect(block.id),
    onUpdate,
    onDelete,
  });

  // ========= 样式（与放映共用 blockStyle，避免编辑器/播放不一致）=========
  const style = blockStyle(block, { interactive: true, selected });

  return (
    <div
      style={style}
      onPointerDown={(e) => startDrag('move', e)}
      onClick={(e) => { e.stopPropagation(); onSelect(block.id); }}
    >
      {/* 文本内容（contentEditable）；手机端不给键盘，整块按下去就是拖动 */}
      <div
        contentEditable={!compact}
        suppressContentEditableWarning
        onPointerDown={compact ? undefined : (e) => e.stopPropagation()}
        onMouseDown={compact ? undefined : (e) => e.stopPropagation()}
        onBlur={(e) => {
          onUpdate({ text: e.currentTarget.innerText });
        }}
        className="outline-none w-full h-full"
        style={{
          padding: block.borderRadius ? 2 : 0,
        }}
      >
        {block.text}
      </div>

      {/* 选中时的 8 个 resize handle */}
      {selected && !compact && (
        <>
          {(['nw','n','ne','e','se','s','sw','w'] as HandlePos[]).map((pos) => (
            <div
              key={pos}
              style={handleStyle(pos)}
              onPointerDown={(e) => startDrag(pos, e)}
            />
          ))}
        </>
      )}
    </div>
  );
}
