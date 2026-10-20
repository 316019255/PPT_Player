import { Pool, types } from 'pg';

/**
 * TIMESTAMPTZ 默认会被 pg 解析成 Date 对象。统一转成 ISO UTC 字符串：
 * JS 侧继续拿到字符串（和原来的 SQLite TEXT 列一致），
 * 而且 `2026-10-16T09:00:00.000Z` 比 SQLite 的 `2026-10-16 09:00:00` 更可靠
 * —— 后者会被 `new Date()` 当成本地时间解析。
 */
types.setTypeParser(1184, (text) => new Date(text).toISOString());

export type SqlParam = string | number | null | boolean;

let pool: Pool | null = null;

function getPool(): Pool {
  if (pool) return pool;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      '缺少 DATABASE_URL：本地写在 .env.local，部署写在 Vercel 的 Environment Variables 里'
    );
  }

  // Supabase pooler 用的是自建 CA（Supabase Root 2021 CA），不在任何系统信任库里。
  // 提供了 DATABASE_CA_CERT（PEM 原文）就走完整校验，否则只加密、不验证链。
  const ca = process.env.DATABASE_CA_CERT?.trim();
  const ssl = ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false };

  // 连接串里的 sslmode 会盖过显式 ssl 选项，而 pg 把 require 当 verify-full 处理，
  // 自建 CA 必然验不过 —— 先摘掉，TLS 行为统一由上面的 ssl 决定。
  const [base, search] = url.split('?');
  const query = new URLSearchParams(search);
  query.delete('sslmode');
  const connectionString = [...query.keys()].length ? `${base}?${query}` : base;

  pool = new Pool({
    connectionString,
    ssl,
    // Serverless 下每个实例各自建池，连接数要小；6543 是事务池模式，用完即还。
    max: 3,
    // 实测：热连接上一条查询 180ms，但空闲超过 10 秒后连接被池子关掉，
    // 下一条查询要先重做 TCP+TLS+认证握手，1.3–3.9 秒。改一页歌词远不止 10 秒，
    // 所以这里宁可乐着连接也别掐 —— 否则「点什么都卡一下」就是这么来的。
    idleTimeoutMillis: 5 * 60_000,
    // 事务池（Supavisor）也会自己掐空闲连接，开 TCP keepalive 让它看到有人在用
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  // 空闲连接被服务端掐断时不让它把进程打挂，下一次请求会重新取连接
  pool.on('error', (err) => console.error('[db] 空闲连接异常:', err.message));
  return pool;
}

export async function all<T>(sql: string, params: SqlParam[] = []): Promise<T[]> {
  const result = await getPool().query(sql, params);
  return result.rows as T[];
}

export async function get<T>(sql: string, params: SqlParam[] = []): Promise<T | undefined> {
  const result = await getPool().query(sql, params);
  return result.rows[0] as T | undefined;
}

/** INSERT ... RETURNING 专用：Postgres 必定回一行，调用方不需要处理「没插进去」 */
export async function insert<T>(sql: string, params: SqlParam[] = []): Promise<T> {
  const result = await getPool().query(sql, params);
  return result.rows[0] as T;
}

/** UPDATE / DELETE / INSERT 不需要回读时使用；changes 是受影响行数 */
export async function run(sql: string, params: SqlParam[] = []): Promise<{ changes: number }> {
  const result = await getPool().query(sql, params);
  return { changes: result.rowCount ?? 0 };
}
