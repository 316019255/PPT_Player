import { get } from './db';

/**
 * 分类必须属于当前用户，否则可以把 PPT 挂进别人的分类。
 *
 * 只认真整数：`Number([3]) === 3`、`Number(true) === 1` 这种 JS 隐式转换，
 * 意味着一个「根本不是分类 id 的形状」也能挂进那位作者的真分类里
 * （探针实测 `{category_id:[7]}` 曾经 200 且真写进库）。
 * 回 null = 「这个值不认」，调用方按非法分类报 400，不悄悄改成未分类。
 */
export async function resolveCategory(
  categoryId: unknown,
  userId: number
): Promise<number | null> {
  if (typeof categoryId !== 'number' || !Number.isInteger(categoryId) || categoryId <= 0) {
    return null;
  }

  const owner = await get<{ id: number }>(
    'SELECT id FROM categories WHERE id = $1 AND user_id = $2',
    [categoryId, userId]
  );
  return owner ? owner.id : null;
}
