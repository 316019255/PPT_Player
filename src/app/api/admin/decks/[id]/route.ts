import { NextResponse } from 'next/server';
import { readJsonBody, requireAdmin } from '@/lib/admin';
import { resolveCategory } from '@/lib/category';
import { normalizeDeckTitle } from '@/lib/deck-title';
import { get } from '@/lib/db';
import type { SqlParam } from '@/lib/db';

type Ctx = { params: Promise<{ id: string }> };

function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

function notFound() {
  return NextResponse.json({ error: '找不到这份演示文稿' }, { status: 404 });
}

async function deckIdOf(params: Promise<{ id: string }>): Promise<number | null> {
  const { id } = await params;
  const deckId = Number(id);
  return Number.isInteger(deckId) && deckId > 0 ? deckId : null;
}

/** PATCH 回读的那几列 —— 列表行里会被改动的部分，合并即可，作者信息不用重查 */
interface DeckPatchResult {
  id: number;
  title: string;
  category_id: number | null;
  category_name: string | null;
  slides: number;
  bytes: number;
  updated_at: string;
}

/**
 * 改名 / 移分类。
 *
 * 关键的一步是分类归属：用**这份稿子的作者**去 resolveCategory，而不是管理员的 id。
 * 拿管理员的 id 去查分类，等于把别人的作品挂进管理员自己的目录 ——
 * 查得到就写进库，前台那位作者看到的是「这叠怎么跑到了我没建过的分类里」。
 */
export async function PATCH(request: Request, { params }: Ctx) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  const deckId = await deckIdOf(params);
  if (deckId === null) return badRequest('缺少有效的 id');

  const body = await readJsonBody(request);
  if (body instanceof NextResponse) return body;

  const owner = await get<{ user_id: number }>(
    'SELECT user_id FROM presentations WHERE id = $1',
    [deckId]
  );
  if (!owner) return notFound();

  const sets: string[] = [];
  const values: SqlParam[] = [];

  if ('title' in body) {
    // 只接受字符串：传个数字进来就悄悄把标题写成「未命名演示文稿」太容易了
    if (typeof body.title !== 'string') return badRequest('标题得是字符串');
    values.push(normalizeDeckTitle(body.title));
    sets.push(`title = $${values.length}`);
  }

  if ('category_id' in body) {
    const raw = body.category_id;
    if (raw === null || raw === undefined) {
      values.push(null);
    } else {
      const target = await resolveCategory(raw, owner.user_id);
      // 挂到不存在、或不属于这位作者的分类要报错，而不是悄悄变成未分类
      if (target === null) {
        return badRequest('这个分类不存在，或者不属于这份稿子的作者');
      }
      values.push(target);
    }
    sets.push(`category_id = $${values.length}`);
  }

  if (sets.length === 0) return badRequest('没有需要保存的内容');

  try {
    // 改完在同一条语句里把要刷进列表的列带回来（含分类名和大小），省一趟跨海往返
    const deck = await get<DeckPatchResult>(
      `WITH upd AS (
         UPDATE presentations SET ${sets.join(', ')}, updated_at = now()
         WHERE id = $${values.length + 1}
         RETURNING id, title, category_id, data, updated_at
       )
       SELECT u.id, u.title, u.category_id, u.updated_at,
              c.name AS category_name,
              slide_count(u.data) AS slides,
              octet_length(u.data) AS bytes
       FROM upd u LEFT JOIN categories c ON c.id = u.category_id`,
      [...values, deckId]
    );

    if (!deck) return notFound();
    return NextResponse.json({ deck });
  } catch (error) {
    const message = error instanceof Error ? error.message : '保存失败';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * 删一份稿子：只删 presentations 的那一行，桶里的素材文件不动。
 * 理由和用户侧一样 —— 素材可能被多份稿子共用，删文件会连带弄坏别的页面。
 * 要清桶是另一件事（后台素材页那条「同时删除桶内文件」只对 lib/ 前缀开放）。
 */
export async function DELETE(_request: Request, { params }: Ctx) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  const deckId = await deckIdOf(params);
  if (deckId === null) return badRequest('缺少有效的 id');

  try {
    // 回读作者邮箱：确认框和提示条都要说清删掉的是谁的哪一叠
    const deleted = await get<{ id: number; title: string; email: string }>(
      `WITH del AS (
         DELETE FROM presentations WHERE id = $1 RETURNING id, title, user_id
       )
       SELECT d.id, d.title, u.email FROM del d JOIN users u ON u.id = d.user_id`,
      [deckId]
    );

    if (!deleted) return notFound();
    return NextResponse.json({ deleted });
  } catch (error) {
    const message = error instanceof Error ? error.message : '删除失败';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
