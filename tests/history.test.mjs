import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GROUP_WINDOW_MS,
  HISTORY_MAX,
  editGroup,
  pushHistory,
  sealTop,
  takeLast,
} from '../src/lib/history.ts';

/** 组名只跟「改了哪些字段 + 哪一页哪一块」有关，所以这里用假 id 就够 */
const SLIDE = 'slide-1';
const BLOCK = 'block-1';

test('打字、拖角、拖滑杆这类连续改动才分组，字段集合一样的才算同一组', () => {
  assert.equal(editGroup(['text'], SLIDE, BLOCK), `text:${SLIDE}:${BLOCK}`);
  // 字段顺序不参与组名：一次手势里 x/y 谁先报都一样
  assert.equal(editGroup(['y', 'x'], SLIDE, BLOCK), editGroup(['x', 'y'], SLIDE, BLOCK));
  // 重复字段不产生新组
  assert.equal(editGroup(['text', 'text'], SLIDE, BLOCK), `text:${SLIDE}:${BLOCK}`);
});

test('换一块、换一页、字段集合不同都不合并；混进一个独立字段就整次都不合并', () => {
  const base = editGroup(['x'], SLIDE, BLOCK);
  assert.notEqual(base, editGroup(['x'], SLIDE, 'block-2'), '不同块不该合成一步');
  assert.notEqual(base, editGroup(['x'], 'slide-2', BLOCK), '不同页不该合成一步');
  assert.notEqual(base, editGroup(['width'], SLIDE, BLOCK), '改了别的尺寸该是新一步');
  // 一次 update 里同时有连续字段和「点一次算一次」的字段：按独立意图处理，别把它并进上一次拖拽
  assert.equal(editGroup(['x', 'fontWeight'], SLIDE, BLOCK), null);
});

test('字号是滑杆拖出来的，属于连续字段；对齐、粗斜、层级不属于', () => {
  assert.notEqual(editGroup(['fontSize'], SLIDE, BLOCK), null);
  for (const f of ['fontWeight', 'fontStyle', 'textAlign', 'zIndex', 'fit', 'bgOpacity']) {
    assert.equal(editGroup([f], SLIDE, BLOCK), null, `${f} 该单独算一步`);
  }
});

test('没有字段变化时不分组，也就不会留下假的一步', () => {
  assert.equal(editGroup([], SLIDE, BLOCK), null);
});

test('同组且还在时间窗内只挪时间，栈里留的是这一串改动开始之前的样子', () => {
  let past = pushHistory([], { v: 0 }, 'text:a:b', 1000);
  past = pushHistory(past, { v: 1 }, 'text:a:b', 1200);
  past = pushHistory(past, { v: 2 }, 'text:a:b', 1400);
  assert.equal(past.length, 1, '连打三个字不该记三步');
  assert.deepEqual(past[0].state, { v: 0 }, '撤销要一次退回整串');
  assert.equal(past[0].at, 1400, '时间戳往后挪，窗才不会提前断');
});

test('超出时间窗就算新的一步', () => {
  let past = pushHistory([], { v: 0 }, 'text:a:b', 1000);
  past = pushHistory(past, { v: 1 }, 'text:a:b', 1000 + GROUP_WINDOW_MS);
  assert.equal(past.length, 2);
  assert.deepEqual(past.map((e) => e.state), [{ v: 0 }, { v: 1 }]);
});

test('不传组名的操作永远各自一步，哪怕紧挨着发生', () => {
  let past = pushHistory([], { v: 0 }, null, 1000);
  past = pushHistory(past, { v: 1 }, null, 1010);
  assert.equal(past.length, 2, '删页、加块、换背景这种点一次的事不能吞掉');
});

test('栈只留最近 HISTORY_MAX 步，超出丢最老的', () => {
  let past = [];
  for (let i = 0; i < HISTORY_MAX + 20; i++) past = pushHistory(past, { v: i }, null, 1000 + i * 2000);
  assert.equal(past.length, HISTORY_MAX);
  assert.deepEqual(past[0].state, { v: 20 }, '丢的是最前面那几步');
  assert.deepEqual(past[past.length - 1].state, { v: HISTORY_MAX + 19 });
});

test('退一步取走栈顶；没得撤时返回 null 而不是崩', () => {
  const past = [{ state: { v: 0 }, group: null, at: 1 }, { state: { v: 1 }, group: null, at: 2 }];
  const taken = takeLast(past);
  assert.deepEqual(taken.entry.state, { v: 1 }, '撤的是最近那一步');
  assert.deepEqual(taken.past, [past[0]]);
  assert.equal(past.length, 2, 'takeLast 不改原数组');
  assert.equal(takeLast([]), null);
});

test('撤完先封口：紧接着的同组改动另起一步，不会和被撤掉的那一串粘回去', () => {
  // 「打字（G）」压了两步：同一串被窗断开，撤回后剩下较早那条
  let past = pushHistory([], { v: 0 }, 'text:a:b', 1000);
  past = pushHistory(past, { v: 1 }, 'text:a:b', 3000);
  const undone = takeLast(past);
  past = sealTop(undone.past);
  past = pushHistory(past, { v: 2 }, 'text:a:b', 3100);
  assert.equal(past.length, 2, '撤完再打的字该是独立一步');
  assert.equal(past[0].group, null, '旧栈顶被封口');
  assert.equal(past[1].group, 'text:a:b', '新一步照常可以继续并');
});

test('没得封的时候封口不改变步数', () => {
  assert.deepEqual(sealTop([]), []);
  const past = [{ state: { v: 0 }, group: null, at: 1 }];
  assert.deepEqual(sealTop(past), past);
});
