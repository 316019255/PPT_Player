import { NextResponse } from 'next/server';
import { getCurrentUserOrGuest } from '@/lib/auth';
import { get, run } from '@/lib/db';

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUserOrGuest();

  const { id } = await params;
  const categoryId = Number(id);
  // 先确认分类属于当前用户，否则别人的分类会被「设为未分类」+ 删掉
  const owned = await get<{ id: number }>('SELECT id FROM categories WHERE id = $1 AND user_id = $2', [
    categoryId,
    user.id,
  ]);
  if (!owned) return NextResponse.json({ error: '未找到' }, { status: 404 });

  // 把该分类下的 PPT 设为未分类
  await run('UPDATE presentations SET category_id = NULL WHERE category_id = $1 AND user_id = $2', [
    categoryId,
    user.id,
  ]);
  await run('DELETE FROM categories WHERE id = $1 AND user_id = $2', [categoryId, user.id]);

  return NextResponse.json({ success: true });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUserOrGuest();

  const { id } = await params;
  const body = (await req.json()) as { name?: unknown };
  const trimmed = typeof body.name === 'string' ? body.name.trim().slice(0, 50) : '';
  if (!trimmed) return NextResponse.json({ error: '名称不能为空' }, { status: 400 });

  const duplicate = await get<{ id: number }>(
    'SELECT id FROM categories WHERE user_id = $1 AND name = $2 AND id != $3',
    [user.id, trimmed, Number(id)]
  );
  if (duplicate) return NextResponse.json({ error: '分类已存在' }, { status: 409 });

  const result = await run('UPDATE categories SET name = $1 WHERE id = $2 AND user_id = $3', [
    trimmed,
    Number(id),
    user.id,
  ]);
  if (result.changes === 0) return NextResponse.json({ error: '未找到' }, { status: 404 });

  return NextResponse.json({ success: true });
}
