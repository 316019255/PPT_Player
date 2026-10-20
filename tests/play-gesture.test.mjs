import test from 'node:test';
import assert from 'node:assert/strict';

import { SWIPE_MIN_DX, swipeSide } from '../src/lib/play-gesture.ts';

test('往左划是下一页、往右划是上一页', () => {
  assert.equal(swipeSide(-120, 0), 'next');
  assert.equal(swipeSide(120, 0), 'prev');
});

test('阈值取到 40px 才算，39px 是擦一下', () => {
  assert.equal(SWIPE_MIN_DX, 40);
  assert.equal(swipeSide(-40, 0), 'next');
  assert.equal(swipeSide(-39, 0), null);
  // 负方向同样按绝对值判
  assert.equal(swipeSide(40, 0), 'prev');
  assert.equal(swipeSide(39, 0), null);
});

test('竖向拖页面不该被抢成翻页', () => {
  assert.equal(swipeSide(-120, 200), null, '往下拖列表结果翻了页');
  assert.equal(swipeSide(120, 201), null);
  assert.equal(swipeSide(0, 400), null, '纯竖向滑动');
  assert.equal(swipeSide(0, 0), null, '手指没动');
});

test('正好 45° 归给翻页：代码用的是严格大于，边界要钉住', () => {
  assert.equal(swipeSide(-60, 60), 'next');
  assert.equal(swipeSide(-60, 61), null);
});

test('刚过阈值又几乎竖着走：两个条件任一不过就不翻', () => {
  assert.equal(swipeSide(-40, 41), null);
  assert.equal(swipeSide(-41, 40), 'next');
});
