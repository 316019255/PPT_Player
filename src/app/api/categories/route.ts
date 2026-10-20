import { NextResponse } from 'next/server';
import { getCurrentUserOrGuest, getViewerUser } from '@/lib/auth';
import { all, get, insert } from '@/lib/db';

interface CategoryRow {
  id: number;
  name: string;
  created_at: string;
}

/** 未分类那一组返回的 category_id 是 NULL，所以这里得允许 null 键 */
interface CountRow {
  category_id: number | null;
  n: number;
}

export async function GET() {
  // 不建档：dashboard 一进场就会拉这个接口，用 getCurrentUserOrGuest 等于给每个匿名访客
  // 先插一行 users 再告诉他「你没有分类」—— 答案本来就该是空的。
  // 建档留给第一次真正的写操作（POST 分类 / 新建 PPT 那条 Route Handler）。
  const user = await getViewerUser();
  if (!user) return NextResponse.json({ categories: [], uncategorized: 0 });

  // 两趟并发（原来是「列表 → 未分类计数」串行三跳，东京实测每跳 180ms）：
  // 分类名和 deck 计数互不依赖，没必要等。计数一次 GROUP BY 扫完全局，
  // 不再给每个分类挂一个相关子查询；NULL 那一组就是未分类。
  // Postgres 的 COUNT 是 bigint，不 ::int 会以字符串返回。
  const [rows, counts] = await Promise.all([
    all<CategoryRow>(
      'SELECT id, name, created_at FROM categories WHERE user_id = $1 ORDER BY created_at DESC',
      [user.id]
    ),
    all<CountRow>(
      'SELECT category_id, COUNT(*)::int AS n FROM presentations WHERE user_id = $1 GROUP BY category_id',
      [user.id]
    ),
  ]);

  const byCategory = new Map<number, number>();
  let uncategorized = 0;
  for (const row of counts) {
    if (row.category_id === null) uncategorized = row.n;
    else byCategory.set(row.category_id, row.n);
  }

  return NextResponse.json({
    categories: rows.map((row) => ({ ...row, ppt_count: byCategory.get(row.id) ?? 0 })),
    uncategorized,
  });
}

export async function POST(request: Request) {
  const user = await getCurrentUserOrGuest();

  const body = (await request.json()) as { name?: unknown };
  const trimmed = typeof body.name === 'string' ? body.name.trim().slice(0, 50) : '';
  if (!trimmed) return NextResponse.json({ error: '名称不能为空' }, { status: 400 });

  const existing = await get<{ id: number }>(
    'SELECT id FROM categories WHERE user_id = $1 AND name = $2',
    [user.id, trimmed]
  );
  if (existing) return NextResponse.json({ error: '分类已存在' }, { status: 409 });

  const row = await insert<{ id: number }>(
    'INSERT INTO categories (user_id, name) VALUES ($1, $2) RETURNING id',
    [user.id, trimmed]
  );
  return NextResponse.json({ id: row.id, name: trimmed });
}
