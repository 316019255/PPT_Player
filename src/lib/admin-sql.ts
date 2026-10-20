/**
 * 后台两条列表的 SQL 文本怎么拼，单独一份、不碰 db：
 * Node 的单测（tests/admin-sql.test.mjs）能在没有库的情况下检查
 * 「语句里的占位符编号」和「参数数组的长度」是不是配得上 ——
 * 这两样对不上时 Postgres 不是返回空结果，而是整条语句报错、接口 500，
 * 而它只在「越界页 + 某些筛选组合」这种点不出来的路径上才暴露。
 *
 * 这里的 import 带 .ts 后缀：tsconfig 开了 allowImportingTsExtensions，
 * Node 的 ESM 解析器只认得到带后缀的写法，而 '.' 后缀那种是 bundler 才补的。
 */
import { GUEST_EMAIL_SUFFIX, ilikeContains } from './validate.ts';
import { USER_PAGE_SIZE, type UserTier } from './admin-users.ts';
import { DECK_PAGE_SIZE, type DeckCategoryFilter } from './admin-decks.ts';

/**
 * 一页列表 = 取数那条 + 越界页补计数那条，SQL 和参数一起造出来。
 *
 * 补计数存在的理由：COUNT(*) OVER() 是搭在返回行上的，OFFSET 翻过头时一行都没有，
 * total 也就没了载体，于是回一个 total=0 —— 那是在说「没有这样的人」，
 * 而实际是 53 个，只是这一页站到了边界外。越界页在界面上点不出来
 * （换筛选会把 page 归 1，末页的「下一页」也是禁用的），只有手改地址栏或脚本才走到这儿，
 * 所以补计数只在空页 + page>1 时多付一趟。
 */
export interface PageQuery {
  sql: string;
  params: (string | number)[];
  countSql: string;
  countParams: (string | number)[];
  page: number;
}

/**
 * 一条查询的参数怎么长出来：占位符编号跟着数组走，不手工数。
 * 关键是「用到才占位」—— 游客判据那个后缀在 SELECT 里算 is_guest 时要用一次，
 * 在 WHERE 里筛游客时又要用一次，而越界页补的那条 COUNT 两样都不带；
 * 固定把它摆在 $1 就会给那条 0 占位符的语句硬塞一个参数，
 * Postgres 直接报错（bind message supplies 1 parameters, requires 0）→ 整个接口 500。
 */
interface QueryArgs {
  params: (string | number)[];
  add(value: string | number): string;
  /** 游客判据的后缀：同一条查询里多次引用只占一位 */
  guest(): string;
  /** WHERE 已经用到的参数个数 —— 补计数那条只带这一段 */
  mark(): number;
}

function newQuery(): QueryArgs {
  const params: (string | number)[] = [];
  let guestPh: string | null = null;
  return {
    params,
    add(value) {
      params.push(value);
      return `$${params.length}`;
    },
    guest() {
      if (guestPh === null) {
        params.push(GUEST_EMAIL_SUFFIX);
        guestPh = `$${params.length}`;
      }
      return guestPh;
    },
    mark() {
      return params.length;
    },
  };
}

/**
 * 游客行的形状判据（guest_{token}@ppt-player.local，见 validate.guestEmail）在 SQL 里只写这一处。
 * 不用 LIKE：`_` 在 LIKE 里是单字符通配，会把 guestX… 这种也算成游客。
 */
const guestIs = (ph: string) => `(starts_with(email, 'guest_') AND right(email, LENGTH(${ph})) = ${ph})`;

/**
 * 「现在算不算会员」在 SQL 里也有一份（对上是 validate.proIsActive，对下是 admin-users.membershipState），
 * 是刻意的：筛必须落在 SQL 里，分页和 COUNT(*) OVER() 才对得上，
 * 三处判据都是「pro=1 且（没有到期日 或 到期日在 now 之后）」。
 */
const PRO_ACTIVE_SQL = `(pro = 1 AND (pro_expires_at IS NULL OR pro_expires_at > now()))`;

export function buildUserPageQuery(filters: { tier?: UserTier; q?: string; page?: number } = {}): PageQuery {
  const args = newQuery();
  const tier = filters.tier ?? 'all';

  const where = [
    tier === 'pro'
      ? PRO_ACTIVE_SQL
      : tier === 'free'
        ? `NOT ${PRO_ACTIVE_SQL} AND NOT ${guestIs(args.guest())}`
        : tier === 'guest'
          ? guestIs(args.guest())
          : // 默认档排除游客：线上 62 行里 53 行是没邮箱没密码的游客壳子，
            // 管理员要管的「用户」不该被这些淹掉。想看游客就切「游客」档。
            `NOT ${guestIs(args.guest())}`,
  ];

  const term = filters.q?.trim();
  if (term) {
    const ph = args.add(ilikeContains(term));
    where.push(`(email ILIKE ${ph} OR name ILIKE ${ph})`);
  }

  // WHERE 用到的参数到此为止；补计数那条只带这一段
  const whereArgs = args.mark();

  const page = Number.isFinite(filters.page) ? Math.max(1, Math.trunc(filters.page!)) : 1;
  const isGuest = guestIs(args.guest());
  const limitPh = args.add(USER_PAGE_SIZE);
  const offsetPh = args.add((page - 1) * USER_PAGE_SIZE);

  // ppt_count 走 presentations(user_id) 的索引；total 用窗口函数顺带带回，
  // 省掉第二条 SELECT COUNT(*) —— 一趟东京 180ms。
  return {
    page,
    params: args.params,
    countParams: args.params.slice(0, whereArgs),
    countSql: `SELECT COUNT(*)::int AS n FROM users WHERE ${where.join(' AND ')}`,
    sql: `SELECT id, email, name, pro, pro_expires_at, created_at,
            ${isGuest} AS is_guest,
            (SELECT COUNT(*)::int FROM presentations p WHERE p.user_id = users.id) AS ppt_count,
            COUNT(*) OVER ()::int AS total
     FROM users
     WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC, id DESC
     LIMIT ${limitPh} OFFSET ${offsetPh}`,
  };
}

/**
 * PPT 列表的 SQL。纯判断（分页大小、筛选值的形状、字节怎么显示）在 ./admin-decks。
 *
 * 这一条绝不 SELECT p.data：一份 31 页的歌稿是 160KB，一页 30 行就是 5MB 跨海字节，
 * 而列表只需要「几页、多大、谁的、在哪个分类」。页数走库里那个 slide_count()
 * （它对坏 JSON 回 0，不会让整条列表 500），大小走 octet_length —— 和存盘那条 2MB 上限同一个口径。
 */
const DECK_FROM = `FROM presentations p
     JOIN users u ON u.id = p.user_id
     LEFT JOIN categories c ON c.id = p.category_id`;

export function buildDeckPageQuery(
  filters: {
    userId?: number | null;
    categoryId?: DeckCategoryFilter;
    q?: string;
    page?: number;
  } = {}
): PageQuery {
  const args = newQuery();
  const where: string[] = [];

  if (filters.userId) {
    where.push(`p.user_id = ${args.add(filters.userId)}`);
  }
  const categoryId = filters.categoryId ?? 'all';
  if (categoryId === 'none') {
    where.push('p.category_id IS NULL');
  } else if (typeof categoryId === 'number') {
    where.push(`p.category_id = ${args.add(categoryId)}`);
  }

  const term = filters.q?.trim();
  if (term) {
    // 一个占位符三处共用：标题、作者邮箱、作者姓名。通配符得转义（搜 `_` 不该等于全表）
    const ph = args.add(ilikeContains(term));
    where.push(`(p.title ILIKE ${ph} OR u.email ILIKE ${ph} OR u.name ILIKE ${ph})`);
  }

  // WHERE 用到的参数到此为止；补计数那条只带这一段（一个筛选项都没有时就是 0 个参数）
  const whereArgs = args.mark();

  const page = Number.isFinite(filters.page) ? Math.max(1, Math.trunc(filters.page!)) : 1;
  const isGuest = guestIs(args.guest());
  const limitPh = args.add(DECK_PAGE_SIZE);
  const offsetPh = args.add((page - 1) * DECK_PAGE_SIZE);
  const condition = where.length ? where.join(' AND ') : 'TRUE';

  // LEFT JOIN categories 是 1:0..1，一条稿子只有一个分类，计数不会被它放大
  return {
    page,
    params: args.params,
    countParams: args.params.slice(0, whereArgs),
    countSql: `SELECT COUNT(*)::int AS n ${DECK_FROM} WHERE ${condition}`,
    sql: `SELECT p.id, p.title, p.user_id, p.category_id, p.created_at, p.updated_at,
            u.email, u.name, ${isGuest} AS is_guest,
            c.name AS category_name,
            slide_count(p.data) AS slides,
            octet_length(p.data) AS bytes,
            COUNT(*) OVER ()::int AS total
     ${DECK_FROM}
     WHERE ${condition}
     ORDER BY p.updated_at DESC, p.id DESC
     LIMIT ${limitPh} OFFSET ${offsetPh}`,
  };
}
