import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin';
import { listDecks } from '@/lib/admin-data';
import {
  DECK_PAGE_SIZE,
  parseDeckCategory,
  parseDeckUserId,
} from '@/lib/admin-decks';

/**
 * 后台 PPT 列表：userId / categoryId / q / page 四个筛选都落在 SQL 里，
 * 一次查询带回 total，不给前端「先拉全表再本地筛」的选项 ——
 * 全表是 data 加起来几十 MB 的那种全表。
 */
export async function GET(request: Request) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  const { searchParams } = new URL(request.url);
  const rawPage = Number(searchParams.get('page') ?? '1');

  try {
    const { rows, total } = await listDecks({
      userId: parseDeckUserId(searchParams.get('userId')),
      categoryId: parseDeckCategory(searchParams.get('categoryId')),
      q: searchParams.get('q') ?? undefined,
      page: Number.isFinite(rawPage) ? rawPage : 1,
    });
    return NextResponse.json({ decks: rows, total, pageSize: DECK_PAGE_SIZE });
  } catch (error) {
    const message = error instanceof Error ? error.message : '查询失败';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
