import test from 'node:test';
import assert from 'node:assert/strict';

import {
  adminEmails,
  guestEmail,
  isAdminEmail,
  isGuestEmail,
  isValidEmail,
  ilikeContains,
  normalizeEmail,
  passwordProblem,
  proIsActive,
} from '../src/lib/validate.ts';

const DAY = 24 * 60 * 60 * 1000;
const stamp = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString();

test('邮箱先归一化再校验', () => {
  assert.equal(normalizeEmail('  Alice@Example.COM '), 'alice@example.com');
  assert.equal(isValidEmail('alice@example.com'), true);
  assert.equal(isValidEmail('a@b.co'), true);
  assert.equal(isValidEmail('alice@example'), false, '缺少顶级域');
  assert.equal(isValidEmail('ali ce@example.com'), false);
  assert.equal(isValidEmail('a@b.c'), false, '顶级域至少两个字符');
  assert.equal(isValidEmail(`${'x'.repeat(250)}@example.com`), false, '整体长度也要有上限');
});

test('密码长度区间（bcrypt 的 72 字节硬限制）', () => {
  assert.equal(passwordProblem('1234567'), '密码至少 8 位');
  assert.equal(passwordProblem('12345678'), null);
  assert.equal(passwordProblem('x'.repeat(73)), '密码最长 72 位');
  assert.equal(passwordProblem(undefined), '密码至少 8 位');
});

test('Pro 只有在标记为真且未过期时生效', () => {
  assert.equal(proIsActive(0, null), false);
  assert.equal(proIsActive(null, null), false);
  assert.equal(proIsActive(undefined, stamp(10)), false);
  assert.equal(proIsActive(1, null), true, '没有过期时间视为长期有效');
  assert.equal(proIsActive(1, stamp(-1)), false, '昨天到期就不再是 Pro');
  assert.equal(proIsActive(1, stamp(1)), true);
  assert.equal(proIsActive(1, 'not-a-date'), true, '读不懂的时间不做惩罚');
});

test('过期时间按 UTC 时刻判定，不受本机时区影响', () => {
  assert.equal(proIsActive(1, new Date(Date.now() - 60_000).toISOString()), false, '一分钟前到期');
  assert.equal(proIsActive(1, new Date(Date.now() + 60_000).toISOString()), true, '一分钟后才到期');
});

test('游客合成邮箱只认 guest_ 前缀 + 本站保留域后缀', () => {
  assert.equal(guestEmail('abc123'), 'guest_abc123@ppt-player.local');
  assert.equal(isGuestEmail(guestEmail('abc123')), true);
  assert.equal(isGuestEmail('admin@example.com'), false);
  assert.equal(isGuestEmail('someone@ppt-player.local'), false, '只有 guest_ 前缀才算游客');
  assert.equal(isGuestEmail('guest_abc123@example.com'), false, '后缀不对就不是游客');
});

test('管理员名单：现读 env、归一化、空名单和游客一律拒绝', () => {
  const saved = process.env.ADMIN_EMAILS;
  try {
    process.env.ADMIN_EMAILS = ' Admin@Example.com ,, x@y.z ';
    assert.deepEqual(adminEmails(), ['admin@example.com', 'x@y.z']);
    assert.equal(isAdminEmail('ADMIN@example.com'), true, '大小写不敏感');
    assert.equal(isAdminEmail('  x@y.z  '), true, '比之前也先归一化（含首尾空格）');
    assert.equal(isAdminEmail('other@example.com'), false);
    assert.equal(isAdminEmail(undefined), false);

    // 误把游客合成邮箱填进名单：不放行。游客没有可登录的身份，后台入口不该亮给访客会话
    process.env.ADMIN_EMAILS = guestEmail('deadbeef');
    assert.equal(isAdminEmail(guestEmail('deadbeef')), false);

    // 漏配 env：后台关着，而不是谁都能进
    process.env.ADMIN_EMAILS = '';
    assert.equal(adminEmails().length, 0);
    assert.equal(isAdminEmail('admin@example.com'), false);
    delete process.env.ADMIN_EMAILS;
    assert.equal(isAdminEmail('admin@example.com'), false, '变量整个不存在时同样拒绝');
  } finally {
    if (saved === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = saved;
  }
});

/**
 * 搜索框里的 `%` `_` `\` 是 LIKE 的通配符/转义符，不是普通字符。
 * 这里只断言「转义成什么串」，Postgres 认不认这个转义由探针在真库上验
 * （搜一个 _ 不许等于全表命中）。
 */
test('搜索词里的通配符逐个加转义，普通字符一个不动', () => {
  assert.equal(ilikeContains('tom'), '%tom%');
  assert.equal(ilikeContains('guest_'), '%guest\\_%');
  assert.equal(ilikeContains('100%'), '%100\\%%');
  assert.equal(ilikeContains('a\\b'), '%a\\\\b%');
  // 顺序：先转义的反斜杠不能把后面补上去的转义符又转一遍
  assert.equal(ilikeContains('\\%_'), '%\\\\\\%\\_%');
  // 大小写、空格、中文都原样留着（ILIKE 自己负责大小写不敏感）
  assert.equal(ilikeContains('张三 Abc '), '%张三 Abc %');
});
