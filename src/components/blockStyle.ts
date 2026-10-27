import type { CSSProperties } from 'react';
import type { ImageBlock, TextBlock, VideoBlock } from '@/types/ppt';
import { hexWithAlpha } from '@/lib/color';
import { DEFAULT_BLOCK_HEIGHT, MIN_CONTENT_LAYER } from '@/lib/block-geometry';

/**
 * 文字块样式的唯一来源：编辑器（可拖拽/选中）与只读渲染（放映 + 缩略图）都走这里，
 * 杜绝「字体/wrap/overflow」在两边漂移导致放映文字比编辑器多占几行、被舞台裁掉。
 *
 * 放在 src/components/ 是因为它要值导入 @/lib/color 与 @/types/ppt ——
 * src/lib/* 必须保持没有运行时 @/ 值导入，才能被 Node 直跑的单测引用。
 */
interface BlockStyleOptions {
  interactive?: boolean;
  selected?: boolean;
}

export function blockStyle(block: TextBlock, opts: BlockStyleOptions = {}): CSSProperties {
  const textAlpha = block.opacity ?? 1;
  const style: CSSProperties = {
    position: 'absolute',
    left: `${block.x}%`,
    top: `${block.y}%`,
    width: `${block.width}%`,
    height: `${block.height ?? DEFAULT_BLOCK_HEIGHT}%`,
    fontSize: `${block.fontSize}px`,
    fontFamily: block.fontFamily,
    // 文字透明度折进颜色：文本框填充另有 bgOpacity，整块 opacity 会把背景一起淡掉
    color: textAlpha >= 1 ? block.color : hexWithAlpha(block.color, textAlpha),
    fontWeight: block.fontWeight,
    fontStyle: block.fontStyle,
    textAlign: block.textAlign,
    zIndex: block.zIndex ?? MIN_CONTENT_LAYER,
    boxSizing: 'border-box',
    background: block.bgColor ? hexWithAlpha(block.bgColor, block.bgOpacity ?? 1) : 'transparent',
    borderRadius: `${block.borderRadius ?? 0}px`,
    border: block.borderColor && block.borderWidth ? `${block.borderWidth}px solid ${block.borderColor}` : 'none',
    padding: `${block.padding ?? 4}px`,
    lineHeight: 1.35,
    // 编辑器和放映一致地按形状裁切（PPT 本身也是裁到框内，除非自动缩放撑大）
    overflow: 'hidden',
    // wrap=false 来自 .pptx 的 bodyPr wrap="none"：保留 \n 但不按框宽折行
    wordBreak: block.wrap === false ? 'normal' : 'break-word',
    whiteSpace: block.wrap === false ? 'pre' : 'pre-wrap',
  };
  if (opts.interactive) {
    style.cursor = 'move';
    style.userSelect = 'none';
    // 不声明 none，浏览器会把手指按下判成滚动页面、当场取消 pointer 流 → 块拖不动
    style.touchAction = 'none';
  }
  if (opts.selected) {
    style.boxShadow = '0 0 0 2px #3b82f6, 0 0 0 4px rgba(59,130,246,0.3)';
  }
  return style;
}

/**
 * 图片块与视频块共享同一套百分比几何：位置/尺寸/zIndex/overflow 完全一致。
 * 抽出来避免两边各写一份然后悄悄漂移。
 */
function mediaBlockStyle(
  block: { x: number; y: number; width: number; height: number; zIndex?: number },
  opts: BlockStyleOptions
): CSSProperties {
  const style: CSSProperties = {
    position: 'absolute',
    left: `${block.x}%`,
    top: `${block.y}%`,
    width: `${block.width}%`,
    height: `${block.height}%`,
    zIndex: block.zIndex ?? MIN_CONTENT_LAYER,
    boxSizing: 'border-box',
    overflow: 'hidden',
  };
  if (opts.interactive) {
    style.cursor = 'move';
    style.userSelect = 'none';
    style.touchAction = 'none';
  }
  if (opts.selected) {
    style.boxShadow = '0 0 0 2px #3b82f6, 0 0 0 4px rgba(59,130,246,0.3)';
  }
  return style;
}

/**
 * 图片块的同一份样式真源。外层不要再挂 `.player-block`：
 * globals.css 把那个类写死成 z-index:2，正是「文字永远压住图片」的来路，
 * 层级只应该由 block.zIndex 决定。
 */
export function imageBlockStyle(block: ImageBlock, opts: BlockStyleOptions = {}): CSSProperties {
  return mediaBlockStyle(block, opts);
}

/** 视频块和图片块是同一层舞台上的兄弟，几何样式完全一致 */
export function videoBlockStyle(block: VideoBlock, opts: BlockStyleOptions = {}): CSSProperties {
  return mediaBlockStyle(block, opts);
}
