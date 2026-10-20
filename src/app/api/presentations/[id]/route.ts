import { NextResponse } from 'next/server';
import { getCurrentUserOrGuest } from '@/lib/auth';
import { resolveCategory } from '@/lib/category';
import { normalizeDeckTitle } from '@/lib/deck-title';
import { get, run } from '@/lib/db';
import { readStoredSlides, serializeSlides } from '@/lib/slide-data';
import type { SqlParam } from '@/lib/db';

interface PresentationRow {
  id: number;
  title: string;
  category_id: number | null;
  data: string;
  created_at: string;
  updated_at: string;
}

type Ctx = { params: Promise<{ id: string }> };

function notFound() {
  return NextResponse.json({ error: '未找到' }, { status: 404 });
}

export async function GET(_request: Request, { params }: Ctx) {
  const user = await getCurrentUserOrGuest();

  const { id } = await params;
  const presentation = await get<PresentationRow>(
    'SELECT id, title, category_id, data, created_at, updated_at FROM presentations WHERE id = $1 AND user_id = $2',
    [Number(id), user.id]
  );

  if (!presentation) return notFound();

  return NextResponse.json({
    presentation: {
      id: presentation.id,
      title: presentation.title,
      category_id: presentation.category_id,
      data: readStoredSlides(presentation.data),
      created_at: presentation.created_at,
      updated_at: presentation.updated_at,
    },
  });
}

export async function PUT(request: Request, { params }: Ctx) {
  const user = await getCurrentUserOrGuest();

  const { id } = await params;
  const presentationId = Number(id);

  try {
    const body = (await request.json()) as {
      title?: unknown;
      data?: unknown;
      category_id?: unknown;
    };
    const sets: string[] = [];
    const values: SqlParam[] = [];

    if (typeof body.title === 'string') {
      values.push(normalizeDeckTitle(body.title));
      sets.push(`title = $${values.length}`);
    }
    if (body.data !== undefined) {
      const serialized = serializeSlides(body.data);
      if (!serialized.ok) return NextResponse.json({ error: serialized.reason }, { status: 400 });
      values.push(serialized.json);
      sets.push(`data = $${values.length}`);
    }
    if ('category_id' in body) {
      const target =
        body.category_id === null || body.category_id === undefined
          ? null
          : await resolveCategory(body.category_id, user.id);
      // 挂到不存在或不属于自己的分类要报错，而不是悄悄变成未分类
      if (target === null && body.category_id != null) {
        return NextResponse.json({ error: '分类不存在' }, { status: 400 });
      }
      values.push(target);
      sets.push(`category_id = $${values.length}`);
    }

    if (sets.length === 0) {
      return NextResponse.json({ error: '没有需要保存的内容' }, { status: 400 });
    }

    sets.push('updated_at = now()');
    values.push(presentationId);
    // 归属条件留在 WHERE 里：改到 0 行就是「没有这份稿子」，不再单独探一次
    const result = await run(
      `UPDATE presentations SET ${sets.join(', ')} WHERE id = $${values.length} AND user_id = $${values.length + 1}`,
      [...values, user.id]
    );

    if (result.changes === 0) return notFound();

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : '保存失败';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: Ctx) {
  const user = await getCurrentUserOrGuest();

  const { id } = await params;
  const result = await run('DELETE FROM presentations WHERE id = $1 AND user_id = $2', [
    Number(id),
    user.id,
  ]);

  if (result.changes === 0) return notFound();

  // 顺带清理该演示文稿独占的上传素材？
  // 不做：素材可能被多个演示文稿共用，删除会影响其它页面。
  return NextResponse.json({ success: true });
}
