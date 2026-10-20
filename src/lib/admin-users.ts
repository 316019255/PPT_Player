/**
 * 后台用户页的纯逻辑，单独一个文件、不碰 db / pg：
 * 视图（'use client'）要 import 这里的常量和判断函数，
 * 从 admin-data 拖进来就等于把整个 pg 打进浏览器包。
 */

/** 一页 30 行：后台一次扫 30 个人足够，再多就是白付的跨海字节 */
export const USER_PAGE_SIZE = 30;

/** 自定义天数最多 10 年：再长就等价于「永久」，而「永久」另有那一项 */
export const GRANT_DAYS_MAX = 3650;

export interface UserRow {
  id: number;
  email: string;
  name: string;
  pro: number;
  pro_expires_at: string | null;
  created_at: string;
}

export interface AdminUserRow extends UserRow {
  /** 由 SQL 算出来的游客标记（见 admin-sql 的 guestIs()） */
  is_guest: boolean;
  ppt_count: number;
  /** 会员状态在查询那一层算好带上：视图里读时间会撞 react-hooks/purity，服务端和浏览器还会各算各的 */
  membership: Membership;
}

export interface UserPage {
  rows: AdminUserRow[];
  total: number;
}

export type UserTier = 'all' | 'pro' | 'free' | 'guest';

const TIERS: readonly UserTier[] = ['all', 'pro', 'free', 'guest'];

/** 认不出来的筛选值退回默认档而不是 500：地址栏手改一个 tier=xxx 不该让页面挂掉 */
export function parseUserTier(value: string | null | undefined): UserTier {
  return TIERS.includes(value as UserTier) ? (value as UserTier) : 'all';
}

export type GrantPlan =
  | { ok: true; pro: 0 | 1; expiresAt: string | null }
  | { ok: false; error: string };

/**
 * 「开会员」只接受三种意图，到期时间一律由服务端按传进来的 nowMs 算。
 * 之前接口直接收客户端传来的 pro / pro_expires_at：形状不对被 pg 冒成 500，
 * 形状对了就能把任意到期日写进库。时钟当参数进来，Node 侧才校得动这四种形状。
 */
export function planGrant(raw: unknown, nowMs: number): GrantPlan {
  if (raw === 'permanent') return { ok: true, pro: 1, expiresAt: null };
  if (raw === 'revoke') return { ok: true, pro: 0, expiresAt: null };

  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const { days } = raw as Record<string, unknown>;
    if (typeof days === 'number' && Number.isInteger(days) && days >= 1 && days <= GRANT_DAYS_MAX) {
      return { ok: true, pro: 1, expiresAt: new Date(nowMs + days * 86_400_000).toISOString() };
    }
    return { ok: false, error: `天数得是 1 到 ${GRANT_DAYS_MAX} 的整数` };
  }

  return { ok: false, error: "grant 只能是 'permanent'、'revoke' 或 { days: 整数 }" };
}

export type Membership = 'guest' | 'permanent' | 'active' | 'expired' | 'free';

/**
 * 那一列显示什么，只由这一个判断决定。
 * 时钟由服务端算好传进来（组件里自己 Date.now() 会撞上 react-hooks/purity，
 * 也会让服务端渲染和浏览器Hydration 各说各话）。
 */
export function membershipState(
  row: Pick<AdminUserRow, 'pro' | 'pro_expires_at' | 'is_guest'>,
  nowMs: number
): Membership {
  if (row.is_guest) return 'guest';
  if (!row.pro) return 'free';
  if (!row.pro_expires_at) return 'permanent';
  const ts = Date.parse(row.pro_expires_at);
  if (Number.isNaN(ts)) return 'permanent';
  return ts > nowMs ? 'active' : 'expired';
}

/**
 * 日期一律截 ISO 串的前 10 位（UTC）显示。
 * 不用 toLocaleDateString：Node 那侧的 ICU 未必带 zh-CN 数据，
 * 服务端渲染出 `10/19/2027`、浏览器渲染出 `2027/10/19` 就是 hydration 不匹配。
 */
export function dayOnly(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '-';
}

const MEMBERSHIP_TEXT: Record<Membership, string> = {
  guest: '游客',
  permanent: '永久会员',
  active: '会员',
  expired: '已过期',
  free: '普通',
};

/** 表格和手机卡片共用这一句文案，两处各写一遍迟早会不一样 */
export function membershipLabel(row: Pick<AdminUserRow, 'membership' | 'pro_expires_at'>): string {
  return row.membership === 'active'
    ? `至 ${dayOnly(row.pro_expires_at)}`
    : MEMBERSHIP_TEXT[row.membership];
}
