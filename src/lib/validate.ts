const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidEmail(value: string): boolean {
  return value.length <= 254 && EMAIL_RE.test(value);
}

/**
 * 搜索框是「包含」语义，所以要把原文夹进 % 里；但原文自己也可能带 LIKE 的通配符：
 * `%` 匹配任意串、`_` 匹配任意单字符、`\` 是转义符（Postgres 的 LIKE 默认就拿它当转义符）。
 * 不转义的话搜一个 `_` 就等于全表命中，搜 `a%b` 会把 `axxxb` 也捞出来 ——
 * 邮箱和文件名里出现下划线太常见了（guest_xxx、up_mv1a2b3c），这不是构造出来的边界。
 * 值走的是参数化占位符，所以这里只管通配符语义，不涉及注入。
 */
export function ilikeContains(raw: string): string {
  return `%${raw.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

export function passwordProblem(password: string): string | null {
  if (typeof password !== 'string' || password.length < 8) return '密码至少 8 位';
  if (password.length > 72) return '密码最长 72 位';
  return null;
}

/**
 * pro_expires_at 是 Postgres TIMESTAMPTZ 转出的 ISO UTC 字符串（见 db.ts 的类型解析器）。
 * pro 只有在标记为 1 且未过期时才生效；没有过期时间视为长期有效。
 */
export function proIsActive(pro: number | boolean | null | undefined, expiresAt: string | null): boolean {
  if (!pro) return false;
  if (!expiresAt) return true;
  const ts = Date.parse(expiresAt);
  if (Number.isNaN(ts)) return true;
  return ts > Date.now();
}

/**
 * 游客账号没有可登录的身份，靠这个合成邮箱形状和真实用户区分。
 * 拼法、判断都只留这一处（auth.ts 建档用它，后台筛掉游客也用它）。
 */
export const GUEST_EMAIL_SUFFIX = '@ppt-player.local';

export function guestEmail(token: string): string {
  return `guest_${token}${GUEST_EMAIL_SUFFIX}`;
}

export function isGuestEmail(email: string): boolean {
  return email.startsWith('guest_') && email.endsWith(GUEST_EMAIL_SUFFIX);
}

/**
 * 管理员名单每次调用现读 env，不在模块顶层求值：顶层求值会把值冻在模块加载那一刻，
 * 改 `.env.local` 不重启就看不到，Node 侧也没法用不同名单跑同一条规则。
 */
export function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => normalizeEmail(e))
    .filter(Boolean);
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  // 游客身份不认：名单被误填成 guest_xxx@ppt-player.local 时也不该给后台
  if (isGuestEmail(email)) return false;
  // 名单为空一律拒绝：漏配 env 应该是「后台关着」，而不是「谁都能进」
  const list = adminEmails();
  return list.length > 0 && list.includes(normalizeEmail(email));
}
