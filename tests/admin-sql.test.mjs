import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDeckPageQuery, buildUserPageQuery } from '../src/lib/admin-sql.ts';

/** SQL 里用到的占位符编号，去重后升序 */
function used(sql) {
  return [...new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
}

/**
 * 这一条是踩过坑的：参数数组比语句用到的占位符长一个，
 * Postgres 直接报 「bind message supplies 1 parameters, but prepared statement requires 0」，
 * 整个列表接口 500。游客判据的后缀以前固定占 $1 —— 而越界页补的那条 COUNT
 * 既不筛游客、也不算 is_guest，于是它拿到一个没人引用的参数。
 */
function assertPaired(sql, params, label) {
  const nums = used(sql);
  assert.deepEqual(nums, Array.from({ length: nums.length }, (_, i) => i + 1), `${label}：占位符编号不连续（${nums.join(',')}）`);
  assert.equal(params.length, nums.length, `${label}：参数 ${params.length} 个但语句只用 ${nums.length} 个`);
}

test('PPT 列表：一个筛选项都没有时，补计数那条必须是 0 个参数', () => {
  const q = buildDeckPageQuery({ page: 99 });
  assert.deepEqual(q.countParams, []);
  assert.equal(used(q.countSql).length, 0);
  assertPaired(q.countSql, q.countParams, 'decks count 无筛选');
  assertPaired(q.sql, q.params, 'decks 页 无筛选');
  assert.equal(q.page, 99);
});

test('PPT 列表：四个筛选项各自占位，编号和参数一起长出来', () => {
  const q = buildDeckPageQuery({ userId: 7, categoryId: 3, q: 'guest_', page: 3 });
  assertPaired(q.sql, q.params, 'decks 页 全筛选');
  assertPaired(q.countSql, q.countParams, 'decks count 全筛选');
  assert.deepEqual(q.countParams, [7, 3, '%guest\\_%']);
  assert.equal(q.params.length, q.countParams.length + 3, '页那条多出后缀 + LIMIT + OFFSET 三个');
  assert.equal(q.params[q.countParams.length], '@ppt-player.local', '后缀排在 WHERE 参数之后，不给 count 那条带上');
  assert.equal(q.params[q.params.length - 1], 60, 'OFFSET = (3-1) × 30');
});

test('PPT 列表：分类两种认法都不占参数位', () => {
  // 「未分类」是 IS NULL、「全部」是干脆没有条件，两个都不该往参数数组里塞东西
  assert.deepEqual(buildDeckPageQuery({ categoryId: 'none' }).countParams, []);
  assert.equal(used(buildDeckPageQuery({ categoryId: 'none' }).countSql).length, 0);
  assert.deepEqual(
    used(buildDeckPageQuery({ categoryId: 'none' }).sql),
    used(buildDeckPageQuery({ categoryId: 'all' }).sql),
    'none 和 all 的页查询占位符一样多：后缀 + LIMIT + OFFSET'
  );
  assert.deepEqual(buildDeckPageQuery({ categoryId: 'abc' }).countParams, []);
  // 不存在的分类 id 照样是个正经筛选项，得占一位而不是拼进 SQL
  const q = buildDeckPageQuery({ categoryId: 99999999 });
  assert.deepEqual(q.countParams, [99999999]);
  assert.match(q.countSql, /p\.category_id = \$1/);
});

test('PPT 列表：搜索词里的通配符在两条语句里都是同一个已转义参数', () => {
  const q = buildDeckPageQuery({ q: 'a%_b' });
  assert.deepEqual(q.countParams, ['%a\\%\\_b%']);
  assert.match(q.sql, /p\.title ILIKE \$1 OR u\.email ILIKE \$1 OR u\.name ILIKE \$1/);
  assert.equal(used(q.countSql).length, 1, '三条 OR 共用一个占位符，不是三个');
});

test('PPT 列表：绝不把整份 data 拖回应用', () => {
  const q = buildDeckPageQuery({});
  assert.equal((q.sql.match(/p\.data/g) || []).length, 2, '只许 slide_count() 和 octet_length() 各引用一次');
  assert.ok(q.sql.includes('slide_count(p.data)'));
  assert.ok(q.sql.includes('octet_length(p.data)'));
  assert.ok(!/,\s*p\.data\s*,/.test(q.sql), '没有裸的 p.data 投影列');
});

test('PPT 列表：分页大小和页码归一都落在参数里', () => {
  for (const [raw, want] of [[undefined, 1], [0, 1], [-5, 1], [Number.NaN, 1], [2.7, 2], [30, 30]]) {
    const q = buildDeckPageQuery({ page: raw });
    assert.equal(q.page, want, `page=${String(raw)}`);
    assert.equal(q.params[q.params.length - 2], 30, 'LIMIT 恒为 30');
    assert.equal(q.params[q.params.length - 1], (want - 1) * 30);
    assertPaired(q.sql, q.params, `page=${String(raw)}`);
  }
});

test('用户列表：tier=pro 不筛游客，补计数那条也不该拿到游客后缀', () => {
  for (const tier of ['pro', 'free', 'guest', 'all', undefined]) {
    const q = buildUserPageQuery({ tier });
    assertPaired(q.sql, q.params, `users ${String(tier)} 页`);
    assertPaired(q.countSql, q.countParams, `users ${String(tier)} count`);
  }
  assert.deepEqual(buildUserPageQuery({ tier: 'pro' }).countParams, []);
  assert.deepEqual(buildUserPageQuery({ tier: 'pro', page: 99 }).countParams, [], '越界页补计数那趟正是以前 500 的那趟');
});

test('用户列表：默认档和游客档都要筛游客，后缀就占一位', () => {
  const free = buildUserPageQuery({ tier: 'free', q: '张' });
  assert.deepEqual(free.countParams, ['@ppt-player.local', '%张%']);
  assert.match(free.countSql, /NOT \(starts_with\(email, 'guest_'\).*LENGTH\(\$1\)\).*= \$1/);
  // is_guest 在 SELECT 里再算一次，用的是同一个占位符，不另开一个参数
  assert.equal(used(free.sql).length, free.params.length);
  assert.equal(free.params.filter((p) => p === '@ppt-player.local').length, 1, '后缀只绑定一次');
});

test('用户列表：不 SELECT 演示文稿内容，只数人数', () => {
  const q = buildUserPageQuery({});
  assert.ok(!q.sql.includes('p.data'), 'ppt_count 那个子查询只碰 user_id');
  assert.equal(q.params[q.params.length - 2], 30);
});
