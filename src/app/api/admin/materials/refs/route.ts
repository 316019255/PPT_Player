import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin';
import { countMaterialRefs } from '@/lib/admin-data';

/**
 * 删一条素材之前先问一句「有几份稿子在用它」。
 * 单独一个接口而不是塞进列表 GET：这份计数要扫 presentations 的 data（单条最大 160KB），
 * 挂在列表上等于每次筛选、每次改完重查都付一遍全表扫描，而删除是一秒钟里一次的动作。
 */
export async function GET(request: Request) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  const { searchParams } = new URL(request.url);
  const numId = Number(searchParams.get('id'));
  if (!Number.isInteger(numId) || numId <= 0) {
    return NextResponse.json({ error: '缺少有效的 id' }, { status: 400 });
  }

  const refs = await countMaterialRefs(numId);
  if (refs === null) return NextResponse.json({ error: '找不到这条素材' }, { status: 404 });

  return NextResponse.json({ refs });
}
