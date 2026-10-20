import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin';
import { listDeckCategories } from '@/lib/admin-data';
import { parseDeckUserId } from '@/lib/admin-decks';

/**
 * 「把这份稿子移到哪个分类」的候选清单。
 * userId 是**这份稿子的作者**，不是管理员自己：
 * 分类是每个人的私有目录，管理员的目录和作者的目录不是一回事。
 * 真正的归属校验在 PATCH 里再做一遍（resolveCategory），这里只是取候选。
 */
export async function GET(request: Request) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  const userId = parseDeckUserId(new URL(request.url).searchParams.get('userId'));
  if (!userId) {
    return NextResponse.json({ error: '缺少有效的 userId（这份稿子的作者）' }, { status: 400 });
  }

  try {
    return NextResponse.json({ categories: await listDeckCategories(userId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : '查询失败';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
