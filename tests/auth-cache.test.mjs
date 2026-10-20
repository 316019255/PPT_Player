import test from 'node:test';
import assert from 'node:assert/strict';

import { AuthTtlCache } from '../src/lib/auth-cache.ts';

const snap = (over = {}) => ({ id: 1, email: 'a@b.c', name: 'A', pro: false, ...over });

/** now 由外面喂：测 TTL 不能真的等 20 秒 */
function makeCache(ttlMs = 20_000) {
  let now = 1_000_000;
  return { cache: new AuthTtlCache(ttlMs, () => now), tick: (ms) => (now += ms) };
}

test('TTL 内命中缓存，不再跑第二趟数据库', () => {
  const { cache, tick } = makeCache();
  cache.set('u:1', snap({ pro: true }));
  tick(19_999);
  assert.deepEqual(cache.get('u:1'), snap({ pro: true }));
});

test('过了 TTL 就当作没查到，并且把旧条目清掉不留内存', () => {
  const { cache, tick } = makeCache();
  cache.set('u:1', snap());
  assert.equal(cache.size, 1);
  tick(20_000);
  assert.equal(cache.get('u:1'), undefined);
  assert.equal(cache.size, 0, '过期条目要顺手删掉，不能只当未命中');
});

test('evict 立刻失效：管理员改完 pro 本人下一次请求就得重新查', () => {
  const { cache } = makeCache();
  cache.set('u:1', snap({ pro: true }));
  cache.delete('u:1');
  assert.equal(cache.get('u:1'), undefined);
});

test('账号和游客两条 key 互不干扰', () => {
  const { cache } = makeCache();
  cache.set('u:7', snap({ id: 7, pro: true }));
  cache.set('g:tok', snap({ id: 9, pro: false }));
  assert.equal(cache.get('u:7').id, 7);
  assert.equal(cache.get('g:tok').id, 9);
  cache.delete('u:7');
  assert.equal(cache.get('g:tok').id, 9, '清某个用户不该把游客缓存一起带走');
});

test('写满上限时先扫掉过期的，不至于按用户数线性攒内存', () => {
  const { cache, tick } = makeCache(1_000);
  for (let i = 0; i < 5_000; i++) cache.set(`u:${i}`, snap({ id: i }));
  tick(1_001);
  for (let i = 5_000; i < 5_500; i++) cache.set(`u:${i}`, snap({ id: i }));
  assert.ok(cache.size <= 500, `清理后还剩 ${cache.size} 条，过期的没扫掉`);
});
