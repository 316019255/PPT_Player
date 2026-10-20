import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GRANT_DAYS_MAX,
  USER_PAGE_SIZE,
  membershipLabel,
  membershipState,
  parseUserTier,
  planGrant,
} from '../src/lib/admin-users.ts';

/**
 * 「开会员」只认三种意图，到期时间由服务端算 ——
 * 这一层松了，前端就能把任意到期日直接写进库。
 */
const NOW = Date.parse('2026-10-19T00:00:00.000Z');

test('permanent 就是 pro=1 且没有到期日', () => {
  assert.deepEqual(planGrant('permanent', NOW), { ok: true, pro: 1, expiresAt: null });
});

test('revoke 同时清掉标记和到期日', () => {
  assert.deepEqual(planGrant('revoke', NOW), { ok: true, pro: 0, expiresAt: null });
});

test('days 按服务端这一刻往后推，正好是整天', () => {
  const plan = planGrant({ days: 365 }, NOW);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.pro, 1);
  assert.equal(Date.parse(plan.expiresAt), NOW + 365 * 86_400_000);
});

test('天数不收 0、负数、小数、超上限和字符串', () => {
  for (const days of [0, -1, 1.5, '30', GRANT_DAYS_MAX + 1, NaN, Infinity, null, undefined]) {
    const plan = planGrant({ days }, NOW);
    assert.equal(plan.ok, false, `days=${String(days)} 竟然放行了`);
    if (!plan.ok) assert.match(plan.error, /天数/);
  }
  assert.equal(planGrant({ days: GRANT_DAYS_MAX }, NOW).ok, true, '上限本身要给过');
});

test('grant 缺字段、数组、字符串乱填都是 400 而不是写库', () => {
  for (const raw of [undefined, null, {}, [], ['permanent'], 'pro', 'PRO', 30, true]) {
    assert.equal(planGrant(raw, NOW).ok, false, `grant=${JSON.stringify(raw)} 竟然放行了`);
  }
});

test('认不出的筛选值退回默认档，不给页面 500', () => {
  assert.equal(parseUserTier('pro'), 'pro');
  assert.equal(parseUserTier('guest'), 'guest');
  for (const bad of [null, undefined, '', 'all ', 'PRO', 'everything']) {
    assert.equal(parseUserTier(bad), 'all', `${String(bad)} 应该退回 all`);
  }
});

/** 状态列只有这一处判断，表格和卡片共用 */
test('会员状态的四种样子各归一位', () => {
  const cases = [
    [{ pro: 0, pro_expires_at: null, is_guest: false }, 'free'],
    [{ pro: 1, pro_expires_at: null, is_guest: false }, 'permanent'],
    [{ pro: 1, pro_expires_at: '2999-01-01T00:00:00.000Z', is_guest: false }, 'active'],
    [{ pro: 1, pro_expires_at: '2000-01-01T00:00:00.000Z', is_guest: false }, 'expired'],
    // 游客壳子就算被人手滑写过 pro=1，也先按游客显示
    [{ pro: 1, pro_expires_at: null, is_guest: true }, 'guest'],
    // 库里存进来了一个读不出来的串：宁可当永久，也别把在用的会员踢下线
    [{ pro: 1, pro_expires_at: 'not-a-date', is_guest: false }, 'permanent'],
  ];
  for (const [row, want] of cases) {
    assert.equal(membershipState(row, NOW), want, JSON.stringify(row));
  }
});

test('到期那一档显示日期，别的显示身份', () => {
  assert.equal(membershipLabel({ membership: 'active', pro_expires_at: '2027-10-19T23:30:00.000Z' }), '至 2027-10-19');
  assert.equal(membershipLabel({ membership: 'permanent', pro_expires_at: null }), '永久会员');
  assert.equal(membershipLabel({ membership: 'free', pro_expires_at: null }), '普通');
  assert.equal(membershipLabel({ membership: 'guest', pro_expires_at: null }), '游客');
  assert.equal(membershipLabel({ membership: 'expired', pro_expires_at: '2020-01-01T00:00:00.000Z' }), '已过期');
  // 取 ISO 串的 UTC 日期，不看本机时区：这台机器是 UTC+8，晚上十一点半那笔算哪一天必须固定
  assert.equal(membershipLabel({ membership: 'active', pro_expires_at: '2027-10-19T23:30:00+08:00' }), '至 2027-10-19');
});

test('一页 30 行是接口和分页控件共用的那个数', () => {
  assert.equal(USER_PAGE_SIZE, 30);
});
