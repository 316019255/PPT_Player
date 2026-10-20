import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTOSAVE_IDLE_MS,
  AUTOSAVE_MAX_AGE_MS,
  computeSaveInMs,
  draftIsAhead,
} from '../src/lib/autosave.ts';

const T0 = 1_700_000_000_000;

test('刚改完就等满一个空闲窗口，打字途中一趟都不发', () => {
  assert.equal(computeSaveInMs({ sinceAttempt: T0, now: T0 }), AUTOSAVE_IDLE_MS);
  assert.equal(
    computeSaveInMs({ sinceAttempt: T0, now: T0 + 3_000 }),
    AUTOSAVE_IDLE_MS,
    'now 就是最后一次改动那一刻：空闲窗口从头重开，只有上限跟着上一次尝试走'
  );
});

test('一直打字也躲不过强制上限：距上一次尝试攒够 30 秒立刻落库', () => {
  // 第 29 秒还在打字：空闲那一支要等到第 37 秒，但上限先把时间钉死
  assert.equal(computeSaveInMs({ sinceAttempt: T0, now: T0 + 29_000 }), 1_000);
  // 已经过了上限：等 0 毫秒，也就是这一轮 effect 就跑保存
  assert.equal(computeSaveInMs({ sinceAttempt: T0, now: T0 + 31_000 }), 0);
  assert.equal(computeSaveInMs({ sinceAttempt: T0, now: T0 + 90_000 }), 0, '不能算出负数');
});

test('失败退避被乘法拉长，但同样有 30 秒的顶', () => {
  assert.equal(computeSaveInMs({ sinceAttempt: T0, now: T0, retryTick: 1 }), AUTOSAVE_IDLE_MS * 2);
  // 64 秒的退避太离谱，压回上限：距上一次尝试 30 秒就再试一次
  assert.equal(computeSaveInMs({ sinceAttempt: T0, now: T0, retryTick: 3 }), AUTOSAVE_MAX_AGE_MS);
  assert.equal(computeSaveInMs({ sinceAttempt: T0, now: T0 + 20_000, retryTick: 3 }), 10_000);
});

test('上限按「上一次尝试」算，不是按「第一次变脏」算', () => {
  // 一次尝试失败后（sinceAttempt 推到此刻），退避照样是完整的 16 秒
  const failedAt = T0 + 40_000;
  assert.equal(
    computeSaveInMs({ sinceAttempt: failedAt, now: failedAt + 1_000, retryTick: 1 }),
    AUTOSAVE_IDLE_MS * 2
  );
  // 要是按「第一次变脏」算，这份稿子早就脏过 30 秒：每次都返回 0，退避等于没有
  assert.equal(computeSaveInMs({ sinceAttempt: T0, now: T0 + 41_000, retryTick: 1 }), 0);
});

test('草稿为空的几种情形都不该弹恢复询问', () => {
  const server = { title: 'A', slides: [{ id: 's1' }] };
  assert.equal(draftIsAhead(server, null), false);
});

test('内容一模一样就不算领先，哪怕对象不是同一份', () => {
  const server = { title: 'A', slides: [{ id: 's1', text: '你好' }] };
  const draft = { title: 'A', slides: [{ id: 's1', text: '你好' }] };
  assert.equal(draftIsAhead(server, draft), false);
});

test('标题或页内容任一不同就算领先，宁可多问一次也不漏', () => {
  const server = { title: 'A', slides: [{ id: 's1', text: '你好' }] };
  assert.equal(draftIsAhead(server, { title: 'B', slides: server.slides }), true);
  assert.equal(draftIsAhead(server, { title: 'A', slides: [{ id: 's1', text: '你好吗' }] }), true);
  assert.equal(draftIsAhead(server, { title: 'A', slides: [...server.slides, { id: 's2' }] }), true);
  assert.equal(draftIsAhead(server, { title: 'A', slides: [] }), true, '把页全删了也是改动');
});
