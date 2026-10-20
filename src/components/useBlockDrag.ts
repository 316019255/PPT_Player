'use client';

import { useEffect, useRef, type CSSProperties, type RefObject } from 'react';
import {
  applyResize,
  handleCursor,
  type BlockGeometry,
  type GeometryPatch,
  type HandlePos,
} from '@/lib/block-geometry';

interface Options {
  block: BlockGeometry;
  selected: boolean;
  containerRef: RefObject<HTMLDivElement | null>;
  onSelect: () => void;
  onUpdate: (patch: GeometryPatch) => void;
  onDelete: () => void;
}

/**
 * 块拖拽/缩放：8 个手柄 + 整体移动，坐标一律是舞台百分比。
 * 钳位规则在 `@/lib/block-geometry`，手机端画布外那 4 个屏幕层手柄走的是同一条。
 */
export function useBlockDrag({ block, selected, containerRef, onSelect, onUpdate, onDelete }: Options) {
  const handleRef = useRef<{ pos: HandlePos | 'move'; startX: number; startY: number; orig: BlockGeometry } | null>(null);

  // 鼠标按下：开始拖拽
  const startDrag = (pos: HandlePos | 'move', e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onSelect();
    handleRef.current = {
      pos,
      startX: e.clientX,
      startY: e.clientY,
      orig: { x: block.x, y: block.y, width: block.width, height: block.height },
    };
    (e.target as Element).setPointerCapture(e.pointerId);
  };

  useEffect(() => {
    if (!selected) return;

    // Delete/Backspace 删除
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // 如果不是正在编辑 contentEditable
        const active = document.activeElement;
        if (!active || !(active as HTMLElement).isContentEditable) {
          e.preventDefault();
          onDelete();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, onDelete]);

  // Pointer 事件处理（挂在 window 上）
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const h = handleRef.current;
      if (!h || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      // rect 是缩放后的视觉尺寸，所以位移换算成舞台百分比这一步与舞台缩放无关
      const dx = ((e.clientX - h.startX) / rect.width) * 100;
      const dy = ((e.clientY - h.startY) / rect.height) * 100;
      onUpdate(applyResize(h.pos, h.orig, dx, dy));
    };

    const onUp = () => { handleRef.current = null; };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [containerRef, onUpdate]);

  const handleStyle = (pos: HandlePos): CSSProperties => ({
    position: 'absolute',
    width: 10, height: 10,
    background: '#fff',
    border: '1.5px solid #3b82f6',
    borderRadius: 2,
    cursor: handleCursor(pos),
    zIndex: 999,
    ...handlePosition(pos),
  });

  return { startDrag, handleStyle };
}

function handlePosition(pos: HandlePos): CSSProperties {
  const s: CSSProperties = {};
  const offset = -5; // handle 中心对齐边缘
  if (pos.includes('n')) s.top = offset;
  if (pos.includes('s')) s.bottom = offset;
  if (pos.includes('w')) s.left = offset;
  if (pos.includes('e')) s.right = offset;
  if (pos === 'n' || pos === 's') { s.left = '50%'; s.transform = 'translateX(-50%)'; }
  if (pos === 'e' || pos === 'w') { s.top = '50%'; s.transform = 'translateY(-50%)'; }
  return s;
}
