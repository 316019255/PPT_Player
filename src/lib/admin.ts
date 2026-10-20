import { NextResponse } from 'next/server';
import { getCurrentUser, type AuthUser } from './auth';
import { isAdminEmail } from './validate';

/** 页面用：是管理员就拿到用户，否则 null，调用方自己决定 redirect */
export async function getAdminUser(): Promise<AuthUser | null> {
  const user = await getCurrentUser();
  return user && isAdminEmail(user.email) ? user : null;
}

export type AdminGate = { user: AuthUser } | { response: NextResponse };

/**
 * 接口用：未登录 401，登录了但不在名单里 403。
 * 之前两处都返回 401，等于把「你不是管理员」说成「你没登录」，
 * 前端只会引导用户去重新登录，而重新登录解决不了权限问题。
 *
 * 名单本身怎么算（惰性读 env、空名单一律拒绝、游客邮箱一律不认）在 validate.ts，
 * 那是一碰 next/* 就没法被 Node 单测跑到的东西。
 */
export async function requireAdmin(): Promise<AdminGate> {
  const user = await getCurrentUser();
  if (!user) {
    return { response: NextResponse.json({ error: '请先登录' }, { status: 401 }) };
  }
  if (!isAdminEmail(user.email)) {
    return { response: NextResponse.json({ error: '这个账号没有后台权限' }, { status: 403 }) };
  }
  return { user };
}

export type JsonBody = Record<string, unknown>;

/**
 * 后台写接口的请求体。坏 JSON 会被 request.json() 抛出来，
 * 而 null、"abc"、[1,2] 解析得过去、一按属性取值就是 TypeError ——
 * 两种都是调用方的错，都得是 400，不该冒成 500。
 * 返回体对象，或者一个可以直接 return 给客户端的 400 响应（用 instanceof 区分）。
 */
export async function readJsonBody(request: Request): Promise<JsonBody | NextResponse> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体不是合法的 JSON' }, { status: 400 });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return NextResponse.json({ error: '请求体得是一个对象' }, { status: 400 });
  }
  return parsed as JsonBody;
}
