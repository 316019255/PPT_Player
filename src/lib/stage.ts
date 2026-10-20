/**
 * 幻灯片按固定设计尺寸排版，再用 transform 整体缩放：
 * 这样字号（px）跟位置（%）在任何屏幕上都是等比呈现，
 * 播放页、编辑画布、缩略图共用同一套渲染，不会出现"编辑器看着大、投屏看着小"。
 */
export const DESIGN_WIDTH = 1280;
export const DESIGN_HEIGHT = 720;

export interface StageLayout {
  scale: number;
  left: number;
  top: number;
}

/** 等比缩放到宿主盒子内并居中；盒子还没有尺寸时 scale 为 0，调用方应跳过渲染 */
export function computeStageLayout(box: { w: number; h: number }): StageLayout {
  const scale = Math.min(box.w / DESIGN_WIDTH, box.h / DESIGN_HEIGHT);
  if (!Number.isFinite(scale) || scale <= 0) return { scale: 0, left: 0, top: 0 };
  return {
    scale,
    left: (box.w - DESIGN_WIDTH * scale) / 2,
    top: (box.h - DESIGN_HEIGHT * scale) / 2,
  };
}
