import { NextResponse } from 'next/server';
import { getCurrentUserOrGuest } from '@/lib/auth';
import { resolveCategory } from '@/lib/category';
import { normalizeDeckTitle } from '@/lib/deck-title';
import { ilikeContains } from '@/lib/validate';
import { all, get, insert } from '@/lib/db';
import { FREE_PPT_LIMIT } from '@/types/ppt';
import { serializeSlides } from '@/lib/slide-data';

interface PresentationRow {
  id: number;
  title: string;
  category_id: number | null;
  slide_count: number;
  created_at: string;
  updated_at: string;
  category_name: string | null;
}

async function countPresentations(userId: number): Promise<number> {
  // Postgres 的 COUNT 是 bigint，不 ::int 会以字符串返回
  const row = await get<{ c: number }>(
    'SELECT COUNT(*)::int AS c FROM presentations WHERE user_id = $1',
    [userId]
  );
  return row?.c ?? 0;
}

export async function GET(request: Request) {
  const user = await getCurrentUserOrGuest();

  const { searchParams } = new URL(request.url);
  const categoryId = searchParams.get('category');
  const query = searchParams.get('q');

  const params: (string | number)[] = [user.id];
  let sql = `SELECT p.id, p.title, p.category_id, slide_count(p.data) AS slide_count,
                    p.created_at, p.updated_at, c.name AS category_name
             FROM presentations p LEFT JOIN categories c ON p.category_id = c.id
             WHERE p.user_id = $1`;

  if (categoryId === 'null') {
    sql += ' AND p.category_id IS NULL';
  } else if (categoryId) {
    params.push(Number(categoryId));
    sql += ` AND p.category_id = $${params.length}`;
  }
  if (query) {
    // 转义 % 和 _：否则搜一个下划线就是「所有标题里带下划线的」= 几乎全中，
    // 而用户眼里的「搜索」是字面包含（和后台那一份用的是同一个 helper）
    params.push(ilikeContains(query));
    // SQLite 的 LIKE 对 ASCII 大小写不敏感，Postgres 的 LIKE 敏感，这里要用 ILIKE 才不改行为
    sql += ` AND p.title ILIKE $${params.length}`;
  }
  sql += ' ORDER BY p.updated_at DESC';

  // 列表可以被分类/搜索筛掉，所以总数是另一条查询 —— 但它俩互不依赖，一起发出去
  const [list, totalCount] = await Promise.all([
    all<PresentationRow>(sql, params),
    countPresentations(user.id),
  ]);

  return NextResponse.json({
    presentations: list,
    totalCount,
    pro: !!user.pro,
    limit: FREE_PPT_LIMIT,
  });
}

export async function POST(request: Request) {
  const user = await getCurrentUserOrGuest();

  try {
    const body = (await request.json()) as {
      title?: unknown;
      data?: unknown;
      category_id?: number | null;
    };

    // 配额检查和分类归属互不依赖：串起来发就是每次建 PPT 多付一趟跨海往返。
    // resolveCategory 只读，所以哪怕随后被配额挡下来也不会留下副作用。
    const [count, categoryId] = await Promise.all([
      user.pro ? Promise.resolve(null) : countPresentations(user.id),
      resolveCategory(body.category_id, user.id),
    ]);
    if (count !== null && count >= FREE_PPT_LIMIT) {
      return NextResponse.json(
        { error: `免费版最多 ${FREE_PPT_LIMIT} 个演示文稿，请升级 Pro` },
        { status: 403 }
      );
    }

    const limitedTitle = normalizeDeckTitle(body.title);

    const serialized = serializeSlides(body.data ?? []);
    if (!serialized.ok) return NextResponse.json({ error: serialized.reason }, { status: 400 });

    const row = await insert<{ id: number }>(
      'INSERT INTO presentations (user_id, title, data, category_id) VALUES ($1, $2, $3, $4) RETURNING id',
      [user.id, limitedTitle, serialized.json, categoryId]
    );

    return NextResponse.json({
      id: row.id,
      title: limitedTitle,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '创建失败';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
