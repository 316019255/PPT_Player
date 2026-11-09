import { NextResponse } from 'next/server';
import { get } from '@/lib/db';

/**
 * GET 处理器默认会被预渲染成静态文件。那样每次打这个地址拿的是构建时缓存的响应，
 * 一条 SQL 都不会碰 —— 保活就成了假的，而 Supabase 那边看起来一切正常。
 * 所以这一行是这条路由存在意义的一部分，不是样板代码；tests/keep-alive.test.mjs 会盯住它。
 */
export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' };

/**
 * 保活 + 存活探针：只跑一条最轻的真查询。
 * 不鉴权、不写库、不返回任何业务数据（pg 的报错原文只进服务端日志，不进响应 ——
 * 那里面会带主机名和用户）。
 */
export async function GET() {
  try {
    // 数一张真正承载业务的表，顺带证明 schema 在（COUNT 在 9 行的表上是微秒级）
    await get<{ n: number }>('SELECT COUNT(*)::int AS n FROM presentations');
  } catch (err) {
    console.error('[health] 数据库不可达:', err instanceof Error ? err.message : String(err));
    return NextResponse.json({ ok: false }, { status: 503, headers: NO_STORE });
  }
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
