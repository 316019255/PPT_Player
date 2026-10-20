/**
 * 把 db/schema.sql 应用到 DATABASE_URL 指向的 Postgres（幂等，可重复执行）。
 * 本地：npm run db:push   （等价于 node --env-file=.env.local scripts/db-push.mjs）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('缺少 DATABASE_URL。本地用 npm run db:push（会读 .env.local），CI/部署里直接给环境变量。');
  process.exit(1);
}

// Supabase pooler 用的是自建 CA（Supabase Root 2021 CA），不在任何系统信任库里。
// 给了 DATABASE_CA_CERT（PEM 原文）就走完整校验，没给就只加密、不验证链。
const ca = process.env.DATABASE_CA_CERT?.trim();
const ssl = ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false };

const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'schema.sql');
const sql = fs.readFileSync(schemaPath, 'utf8');

// pg 里连接串的 sslmode 会盖过显式的 ssl 选项，而它把 require 当 verify-full 处理，
// Supabase 自建 CA 必然验不过 —— 所以先把 sslmode 摘掉，TLS 行为统一由上面的 ssl 决定。
const [base, search] = url.split('?');
const query = new URLSearchParams(search);
query.delete('sslmode');
const connectionString = [...query.keys()].length ? `${base}?${query}` : base;

const pool = new pg.Pool({
  connectionString,
  ssl,
  max: 2,
  connectionTimeoutMillis: 15000,
});

try {
  await pool.query(sql);

  const tables = await pool.query(`
    SELECT table_name,
           (SELECT count(*)::int FROM information_schema.columns c WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name) AS cols
    FROM information_schema.tables t
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  console.log('schema 已应用：');
  for (const r of tables.rows) console.log(`  public.${r.table_name} (${r.cols} 列)`);

  const idents = await pool.query(`
    SELECT table_name, column_name, is_identity FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'id' ORDER BY table_name
  `);
  console.log('主键 identity：', idents.rows.map((r) => `${r.table_name}=${r.is_identity}`).join(' '));
} catch (err) {
  console.error('schema 应用失败：', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
