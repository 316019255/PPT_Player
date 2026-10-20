import { NextResponse } from 'next/server';
import { evictAuthCache } from '@/lib/auth';
import { isGuestEmail } from '@/lib/validate';
import { readJsonBody, requireAdmin } from '@/lib/admin';
import { listUsers } from '@/lib/admin-data';
import {
  USER_PAGE_SIZE,
  membershipState,
  parseUserTier,
  planGrant,
  type UserRow,
} from '@/lib/admin-users';
import { get } from '@/lib/db';

/**
 * 后台用户列表：tier / q / page 三个筛选都落在 SQL 里，
 * 一次查询带回 total（窗口函数）和每人的 PPT 数（子查询），不给前端「先拉全表再本地筛」。
 */
export async function GET(request: Request) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  const { searchParams } = new URL(request.url);
  const tier = parseUserTier(searchParams.get('tier'));
  const rawPage = Number(searchParams.get('page') ?? '1');

  try {
    const { rows, total } = await listUsers({
      tier,
      q: searchParams.get('q') ?? undefined,
      page: Number.isFinite(rawPage) ? rawPage : 1,
    });
    return NextResponse.json({ users: rows, total, pageSize: USER_PAGE_SIZE });
  } catch (error) {
    const message = error instanceof Error ? error.message : '查询失败';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * 改会员只接受意图：grant = 'permanent' | { days } | 'revoke'。
 * 到期时间一律在这里算，不接受前端传字符串 —— 传得进任意到期日就等于任意延长会员。
 * 不给游客行授权：那一行没有邮箱也没有密码，pro 写了也没人能享受，
 * 而且它的鉴权缓存按 token（g:{token}）存，evictAuthCache(id) 清不到，最坏要等 60 秒 TTL。
 */
export async function PATCH(request: Request) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  const body = await readJsonBody(request);
  if (body instanceof NextResponse) return body;
  const { id, grant } = body;

  // 一次请求只读一次时钟：算到期日和判状态用的是同一个「现在」
  const nowMs = Date.now();

  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: '缺少有效的 id' }, { status: 400 });
  }
  const plan = planGrant(grant, nowMs);
  if (!plan.ok) {
    return NextResponse.json({ error: plan.error }, { status: 400 });
  }

  const target = await get<{ email: string }>('SELECT email FROM users WHERE id = $1', [id]);
  if (!target) {
    return NextResponse.json({ error: '找不到这个用户' }, { status: 404 });
  }
  if (isGuestEmail(target.email)) {
    return NextResponse.json(
      { error: '这是一条游客记录：没有可登录的邮箱和密码，开了会员也没人能用。想升会员请让对方先注册。' },
      { status: 403 }
    );
  }

  try {
    // 回读并进这条语句：改完立刻拿到新状态，省一趟跨海往返（实测东京 180ms）
    const updated = await get<UserRow>(
      `UPDATE users SET pro = $1, pro_expires_at = $2 WHERE id = $3
       RETURNING id, email, name, pro, pro_expires_at, created_at`,
      [plan.pro, plan.expiresAt, id]
    );
    if (!updated) {
      // 上面查完到这条 UPDATE 之间账号被删了：不能回一个空对象让页面去合并
      return NextResponse.json({ error: '找不到这个用户' }, { status: 404 });
    }

    // 被改的那个人在本实例下次请求要重新查库，别让他接着吃缓存里的旧 pro
    evictAuthCache(id);

    // 状态跟着行一起回：视图那边只渲染，不再自己判时间
    return NextResponse.json({
      user: { ...updated, membership: membershipState({ ...updated, is_guest: false }, nowMs) },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '更新失败';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
