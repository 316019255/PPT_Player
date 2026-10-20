'use client';

import { useEffect, useRef } from 'react';
import {
  DEFAULT_BLOCK_HEIGHT,
  applyResize,
  handleCursor,
  type BlockGeometry,
  type GeometryPatch,
  type HandlePos,
} from '@/lib/block-geometry';
import type { StageLayout } from '@/components/SlideStage';

/** 只给四个角：手机上拉角最常用，边中点会把抽屉那 44px 的按键区挤没 */
const CORNERS: HandlePos[] = ['nw', 'ne', 'se', 'sw'];
/** 看得见的小方块 20px，按得到的热区 44px —— 舞台缩到 0.29 时，块里面的手柄只有 2.8 个像素 */
const HIT = 44;
const DOT = 20;

interface Props {
  /** 舞台在屏幕上的实际位置和像素尺寸（由 SlideStage 上报） */
  layout: StageLayout;
  block: BlockGeometry;
  onPatch: (patch: GeometryPatch) => void;
}

/**
 * 画布外层的缩放手柄：挂在 `transform: scale()` 之外，所以大小跟手指走、不跟着舞台缩。
 * 位移仍然换算成舞台百分比、仍然走 `applyResize` 那一条钳位，编辑器里的 8 个手柄是同一套规则。
 */
export function PhoneResizeHandles({ layout, block, onPatch }: Props) {
  const drag = useRef<{ pos: HandlePos; startX: number; startY: number; orig: BlockGeometry } | null>(null);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || layout.w <= 0 || layout.h <= 0) return;
      onPatch(applyResize(d.pos, d.orig, ((e.clientX - d.startX) / layout.w) * 100, ((e.clientY - d.startY) / layout.h) * 100));
    };
    const onUp = () => { drag.current = null; };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [layout.w, layout.h, onPatch]);

  const height = block.height ?? DEFAULT_BLOCK_HEIGHT;
  // 块角在屏幕上的位置：舞台左上角 + 百分比 × 舞台实际像素
  const cornerOf = (pos: HandlePos) => ({
    x: layout.left + ((pos.includes('w') ? block.x : block.x + block.width) / 100) * layout.w,
    y: layout.top + ((pos.includes('n') ? block.y : block.y + height) / 100) * layout.h,
  });

  return (
    <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 60 }}>
      <div
        className="absolute border border-dashed border-blue-400/70 rounded-sm"
        style={{
          left: layout.left + (block.x / 100) * layout.w,
          top: layout.top + (block.y / 100) * layout.h,
          width: (block.width / 100) * layout.w,
          height: (height / 100) * layout.h,
        }}
      />
      {CORNERS.map((pos) => {
        const { x, y } = cornerOf(pos);
        return (
          <div
            key={pos}
            className="absolute pointer-events-auto flex items-center justify-center"
            style={{
              left: x,
              top: y,
              width: HIT,
              height: HIT,
              marginLeft: -HIT / 2,
              marginTop: -HIT / 2,
              touchAction: 'none',
              cursor: handleCursor(pos),
            }}
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              drag.current = {
                pos,
                startX: e.clientX,
                startY: e.clientY,
                orig: { x: block.x, y: block.y, width: block.width, height },
              };
              (e.target as Element).setPointerCapture(e.pointerId);
            }}
          >
            <span
              className="rounded-[3px] border-2 border-blue-500 bg-white"
              style={{ width: DOT, height: DOT, boxShadow: '0 1px 4px rgba(0,0,0,0.5)' }}
            />
          </div>
        );
      })}
    </div>
  );
}
