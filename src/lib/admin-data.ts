import { all, get } from './db';
import { buildDeckPageQuery, buildUserPageQuery } from './admin-sql';
import { membershipState, type AdminUserRow, type UserPage, type UserTier } from './admin-users';
import {
  type AdminDeckRow,
  type DeckCategoryFilter,
  type DeckCategoryOption,
  type DeckPage,
} from './admin-decks';

/**
 * 后台列表的查询只写这一份：/admin/* 的页面（服务端首屏渲染）和
 * /api/admin/* 的 GET（客户端改筛选后的重查）都调这里。
 * 两处各写一遍 SQL 迟早会漂成两个样子 —— 尤其是加列、改排序的时候。
 */

export interface MaterialRow {
  id: number;
  kind: string;
  url: string;
  thumb_url: string | null;
  category: string;
  tags: string | null;
  alt: string | null;
  title: string;
  sort: number;
  enabled: number;
  created_at: string;
}

export interface MaterialFilters {
  kind?: string;
  category?: string;
}

export const MATERIAL_COLS = 'id, kind, url, thumb_url, category, tags, alt, title, sort, enabled, created_at';

export async function listMaterials(filters: MaterialFilters = {}): Promise<MaterialRow[]> {
  const params: (string | number)[] = [];
  let sql = `SELECT ${MATERIAL_COLS} FROM materials WHERE 1=1`;

  if (filters.kind) {
    params.push(filters.kind);
    sql += ` AND kind = $${params.length}`;
  }
  if (filters.category && filters.category !== 'all') {
    params.push(filters.category);
    sql += ` AND category = $${params.length}`;
  }
  // 和前台素材库同一套排序：sort 大的在前，同一档按 id 升序，种子行才不会乱跳
  sql += ' ORDER BY sort DESC, id ASC';

  return all<MaterialRow>(sql, params);
}

export interface CategoryCount {
  category: string;
  count: number;
}

export async function listMaterialCategories(): Promise<CategoryCount[]> {
  return all<CategoryCount>(
    `SELECT category, COUNT(*)::int AS count FROM materials GROUP BY category ORDER BY count DESC`
  );
}

/**
 * 有多少份稿子正在引用这条素材 —— 后台点删除时现查，不放进列表。
 * 列表 24 行，每行都子查询一遍等于把 presentations 整表扫 24 次（data 最大一条 160KB）；
 * 删一条素材是一秒钟里一次的动作，查一次就够。
 *
 * 用 strpos 而不是 LIKE：素材地址里天然有 `_` 和 `%`（图库 URL 常见），
 * 在 LIKE 里它们是通配符，会把「没有引用」算成「有引用」，反过来也会漏。
 */
export async function countMaterialRefs(id: number): Promise<number | null> {
  const row = await get<{ url: string }>('SELECT url FROM materials WHERE id = $1', [id]);
  if (!row) return null;
  const counted = await get<{ refs: number }>(
    `SELECT COUNT(*)::int AS refs FROM presentations WHERE strpos(data, $1) > 0`,
    [row.url]
  );
  return counted?.refs ?? 0;
}

/**
 * 列表的 SQL 文本在 ./admin-sql 里拼（那一份不碰 db，单测能在没有库时检查
 * 「占位符编号」和「参数个数」配不配得上），这一层只管拿它去问库、把行整理成前端要的形状。
 * 纯判断（游客/会员/到期、grant 入参的形状）在 ./admin-users ——
 * 视图要 import 它，从这份拖过去就把 pg 打进浏览器包了。
 */

export async function listUsers(
  filters: { tier?: UserTier; q?: string; page?: number } = {}
): Promise<UserPage> {
  const { sql, params, countSql, countParams, page } = buildUserPageQuery(filters);

  const rows = await all<Omit<AdminUserRow, 'membership'> & { total: number }>(sql, params);

  let total = rows[0]?.total ?? 0;
  if (rows.length === 0 && page > 1) {
    total = (await get<{ n: number }>(countSql, countParams))?.n ?? 0;
  }

  // 时钟在这一层取：这一层不是组件，视图拿到的是算好的状态，服务端和浏览器不会各算各的
  const nowMs = Date.now();
  const out = rows.map<AdminUserRow>((row) => ({
    id: row.id,
    email: row.email,
    name: row.name,
    pro: row.pro,
    pro_expires_at: row.pro_expires_at,
    created_at: row.created_at,
    is_guest: row.is_guest,
    ppt_count: row.ppt_count,
    membership: membershipState(row, nowMs),
  }));
  return { rows: out, total };
}

/**
 * 列表这一条绝不 SELECT p.data：一份 31 页的歌稿是 160KB，一页 30 行就是 5MB 跨海字节，
 * 而列表只需要「几页、多大、谁的、在哪个分类」—— 那两样在 SQL 里算好了带回来（见 ./admin-sql）。
 */
export async function listDecks(
  filters: { userId?: number | null; categoryId?: DeckCategoryFilter; q?: string; page?: number } = {}
): Promise<DeckPage> {
  const { sql, params, countSql, countParams, page } = buildDeckPageQuery(filters);

  const rows = await all<AdminDeckRow & { total: number }>(sql, params);

  let total = rows[0]?.total ?? 0;
  if (rows.length === 0 && page > 1) {
    total = (await get<{ n: number }>(countSql, countParams))?.n ?? 0;
  }

  // total 是搭在行上的窗口函数，别把它原样吐回前端 —— 每行都带一份同一个数没有意义
  const out = rows.map<AdminDeckRow>((row) => ({
    id: row.id,
    title: row.title,
    user_id: row.user_id,
    email: row.email,
    name: row.name,
    is_guest: row.is_guest,
    category_id: row.category_id,
    category_name: row.category_name,
    slides: row.slides,
    bytes: row.bytes,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));

  return { rows: out, total };
}

/**
 * 「移到哪个分类」的候选：必须是这份稿子作者自己的分类。
 * 管理员自己的分类没有意义 —— 挂上去就是把别人的稿子塞进不相干人的目录，
 * 所以调用方传的是 deck.user_id（作者），不是管理员的 id。
 */
export async function listDeckCategories(userId: number): Promise<DeckCategoryOption[]> {
  return all<DeckCategoryOption>(
    `SELECT id, name FROM categories WHERE user_id = $1 ORDER BY created_at ASC, id ASC`,
    [userId]
  );
}

/**
 * 后台只读预览用的单份稿子：这一条要读 data（放映就得靠它），但按主键取，一行。
 * 和用户侧 play/[id] 唯一的区别就是 WHERE 里没有 user_id —— 管理员看的本来就是别人的稿子。
 */
export interface AdminDeckDetail {
  id: number;
  title: string;
  data: string;
  created_at: string;
  updated_at: string;
  user_id: number;
  email: string;
  name: string;
  category_name: string | null;
}

export async function getDeckForAdmin(id: number): Promise<AdminDeckDetail | null> {
  const row = await get<AdminDeckDetail>(
    `SELECT p.id, p.title, p.data, p.created_at, p.updated_at, p.user_id,
            u.email, u.name, c.name AS category_name
     FROM presentations p
     JOIN users u ON u.id = p.user_id
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.id = $1`,
    [id]
  );
  return row ?? null;
}
