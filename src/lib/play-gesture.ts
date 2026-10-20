/** 手指左右滑翻页的最小横向位移：比这更小的是擦一下、不是翻页意图 */
export const SWIPE_MIN_DX = 40;

/**
 * 只抽这一个判断，是因为阈值最容易悄悄改坏（左右半区点击那种一行式就不值得抽）。
 * 竖向分量超过横向时算「上下拖页面」，手机上列表本来就该竖向滚，不能抢成翻页；正好 45° 归给翻页。
 */
export function swipeSide(dx: number, dy: number): 'prev' | 'next' | null {
  if (Math.abs(dx) < SWIPE_MIN_DX || Math.abs(dy) > Math.abs(dx)) return null;
  // 往左划＝把当前页推走＝下一页（内容跟着手指走，和翻书一个方向）
  return dx < 0 ? 'next' : 'prev';
}
