/**
 * 块几何的唯一来源：编辑器里的 8 个手柄、手机端画布外的 4 个屏幕层手柄、
 * 以及抽屉里的宽高滑杆，都走这一条钳位规则，免得三处各认一套「最小多小、能不能出界」。
 *
 * 这里必须是纯函数且不 import 任何 `@/` 运行时值 —— src/lib/* 要能被 Node 直跑的单测引用。
 */

export type HandlePos = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

/** 拖拽只认这四个数：文字块和图片块共用同一条几何 */
export interface BlockGeometry {
  x: number;
  y: number;
  width: number;
  height?: number;
}

export interface GeometryPatch {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 舞台是 0-100 的百分比坐标系 */
export const STAGE_MAX = 100;
export const MIN_WIDTH = 3;
export const MIN_HEIGHT = 2;
/** 旧数据没有 height：按 12% 估一个框高，编辑器和放映必须用同一个数 */
export const DEFAULT_BLOCK_HEIGHT = 12;

/**
 * dx/dy 是已经换算成舞台百分比的位移，pos 为 'move' 时只平移不改尺寸。
 * 边界按「拖完这一笔之后还剩多少舞台」来钳，所以往右拉 e 手柄不会把块拉出画面。
 */
export function applyResize(
  pos: HandlePos | 'move',
  orig: BlockGeometry,
  dx: number,
  dy: number
): GeometryPatch {
  const o = orig;
  let nx = o.x;
  let ny = o.y;
  let nw = o.width;
  let nh = o.height ?? DEFAULT_BLOCK_HEIGHT;
  const oh = o.height ?? DEFAULT_BLOCK_HEIGHT;

  switch (pos) {
    case 'move':
      nx = clamp(o.x + dx, 0, STAGE_MAX - o.width);
      ny = clamp(o.y + dy, 0, STAGE_MAX - oh);
      break;
    case 'e':
      nw = clamp(o.width + dx, MIN_WIDTH, STAGE_MAX - o.x);
      break;
    case 'w':
      nx = clamp(o.x + dx, 0, STAGE_MAX - o.width);
      nw = clamp(o.width - dx, MIN_WIDTH, STAGE_MAX - nx);
      break;
    case 's':
      nh = clamp(oh + dy, MIN_HEIGHT, STAGE_MAX - o.y);
      break;
    case 'n':
      ny = clamp(o.y + dy, 0, STAGE_MAX - oh);
      nh = clamp(oh - dy, MIN_HEIGHT, STAGE_MAX - ny);
      break;
    case 'se':
      nw = clamp(o.width + dx, MIN_WIDTH, STAGE_MAX - o.x);
      nh = clamp(oh + dy, MIN_HEIGHT, STAGE_MAX - o.y);
      break;
    case 'sw':
      nx = clamp(o.x + dx, 0, STAGE_MAX - o.width);
      nw = clamp(o.width - dx, MIN_WIDTH, STAGE_MAX - nx);
      nh = clamp(oh + dy, MIN_HEIGHT, STAGE_MAX - o.y);
      break;
    case 'ne':
      ny = clamp(o.y + dy, 0, STAGE_MAX - oh);
      nw = clamp(o.width + dx, MIN_WIDTH, STAGE_MAX - o.x);
      nh = clamp(oh - dy, MIN_HEIGHT, STAGE_MAX - ny);
      break;
    case 'nw':
      nx = clamp(o.x + dx, 0, STAGE_MAX - o.width);
      ny = clamp(o.y + dy, 0, STAGE_MAX - oh);
      nw = clamp(o.width - dx, MIN_WIDTH, STAGE_MAX - nx);
      nh = clamp(oh - dy, MIN_HEIGHT, STAGE_MAX - ny);
      break;
  }
  return { x: nx, y: ny, width: nw, height: nh };
}

/** 手柄朝向：斜角用对角线光标，边用单向光标 */
export function handleCursor(pos: HandlePos): string {
  const map: Record<HandlePos, string> = {
    nw: 'nwse-resize', n: 'ns-resize', ne: 'nesw-resize',
    e: 'ew-resize', w: 'ew-resize',
    se: 'nwse-resize', s: 'ns-resize', sw: 'nesw-resize',
  };
  return map[pos];
}

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * 抽屉里的宽高滑杆走的是和拉手柄完全相同的边界：
 * 最小 3% / 2%，最大是「这一块从当前位置到舞台边还剩多少」，所以拖不动也滑不出画面。
 */
export function clampSize(which: 'width' | 'height', value: number, block: BlockGeometry): number {
  return which === 'width'
    ? clamp(value, MIN_WIDTH, STAGE_MAX - block.x)
    : clamp(value, MIN_HEIGHT, STAGE_MAX - block.y);
}
