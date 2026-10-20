import { NextResponse } from 'next/server';
import { evictAuthCache, getCurrentUser } from '@/lib/auth';
import { get } from '@/lib/db';

const PRO_GRANT_ENABLED =
  process.env.NODE_ENV !== 'production' || process.env.ENABLE_DEV_PRO_GRANT === '1';

/**
 * 没有支付接入前的手动升级开关：生产默认关闭，
 * 否则任何人都能自助把自己变成 Pro，配额限制形同虚设。
 */
export async function POST() {
  if (!PRO_GRANT_ENABLED) {
    return NextResponse.json({ error: '升级通道未开放（需接入支付后再启用）' }, { status: 403 });
  }

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // UPDATE 带 RETURNING：回读那一趟纯属白付（实测东京 180ms）
  const row = await get<{ pro: number; pro_expires_at: string | null }>(
    "UPDATE users SET pro = 1, pro_expires_at = now() + INTERVAL '365 day' WHERE id = $1 RETURNING pro, pro_expires_at",
    [user.id]
  );
  // 写完清掉本实例的鉴权缓存：本人下一次请求重新查库，立刻看到 Pro 额度
  evictAuthCache(user.id);

  return NextResponse.json({ pro: !!row?.pro, expiresAt: row?.pro_expires_at ?? null });
}
