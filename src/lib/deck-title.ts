/**
 * 演示文稿标题的唯一一条规则：新建、用户侧重命名、后台改名都走这里。
 * 「trim + 空了兜底 + 截 100」原来在两个 route 里各写一遍，再加后台就是第三遍。
 */
export const DECK_TITLE_MAX = 100;
export const DECK_TITLE_FALLBACK = '未命名演示文稿';

export function normalizeDeckTitle(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  return (text || DECK_TITLE_FALLBACK).slice(0, DECK_TITLE_MAX);
}
