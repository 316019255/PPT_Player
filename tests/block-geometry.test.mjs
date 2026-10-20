import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_BLOCK_HEIGHT,
  MIN_HEIGHT,
  MIN_WIDTH,
  STAGE_MAX,
  applyResize,
  clampSize,
} from '../src/lib/block-geometry.ts';

const POSITIONS = ['move', 'nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** 一个典型歌词条：左上角 (20,20)，宽 50 高 10（舞台百分比） */
const ORIG = { x: 20, y: 20, width: 50, height: 10 };

test('不动手时几何原样返回，height 缺省补成同一个常量', () => {
  assert.deepEqual(applyResize('move', ORIG, 0, 0), { x: 20, y: 20, width: 50, height: 10 });
  assert.deepEqual(applyResize('move', { x: 10, y: 10, width: 30 }, 0, 0), {
    x: 10, y: 10, width: 30, height: DEFAULT_BLOCK_HEIGHT,
  });
});

test('整体移动只平移，不改尺寸', () => {
  const g = applyResize('move', ORIG, 7, -3);
  assert.deepEqual(g, { x: 27, y: 17, width: 50, height: 10 });
});

test('旧数据没有 height 时按估算值参与钳位，并被写回成一个真实高度', () => {
  // y=95、估算高 12 → 只剩 5 的可移动余量，往下拖不动也不该出界
  const g = applyResize('move', { x: 10, y: 95, width: 30 }, 0, 40);
  assert.equal(g.y, STAGE_MAX - DEFAULT_BLOCK_HEIGHT);
  assert.equal(g.height, DEFAULT_BLOCK_HEIGHT);
});

test('四条边各自只改一个维度', () => {
  assert.deepEqual(applyResize('e', ORIG, 10, 99), { x: 20, y: 20, width: 60, height: 10 });
  assert.deepEqual(applyResize('w', ORIG, -10, 99), { x: 10, y: 20, width: 60, height: 10 });
  assert.deepEqual(applyResize('s', ORIG, 99, 10), { x: 20, y: 20, width: 50, height: 20 });
  assert.deepEqual(applyResize('n', ORIG, 99, -10), { x: 20, y: 10, width: 50, height: 20 });
});

test('对角的两个方向同时生效', () => {
  assert.deepEqual(applyResize('se', ORIG, 5, 6), { x: 20, y: 20, width: 55, height: 16 });
  assert.deepEqual(applyResize('nw', ORIG, 5, 6), { x: 25, y: 26, width: 45, height: 4 });
});

test('缩到最小就不再加：宽 3、高 2', () => {
  const w = applyResize('w', ORIG, 100, 0);
  assert.equal(w.width, MIN_WIDTH);
  const n = applyResize('n', ORIG, 0, 100);
  assert.equal(n.height, MIN_HEIGHT);
});

test('拉到头也只能贴着舞台边，不会越过 100%', () => {
  assert.equal(applyResize('e', ORIG, 500, 0).width, STAGE_MAX - ORIG.x);
  assert.equal(applyResize('s', ORIG, 0, 500).height, STAGE_MAX - ORIG.y);
  assert.equal(applyResize('move', ORIG, 500, 500).x, STAGE_MAX - ORIG.width);
  assert.equal(applyResize('move', ORIG, 500, 500).y, STAGE_MAX - ORIG.height);
  // 反向同理：越界就停在 0
  assert.equal(applyResize('move', ORIG, -500, -500).x, 0);
  assert.equal(applyResize('move', ORIG, -500, -500).y, 0);
});

test('任意方向怎么拖，块都还在舞台里且尺寸不为负', () => {
  for (const pos of POSITIONS) {
    for (const dx of [-1000, -120, -50, -8, 0, 8, 50, 120, 1000]) {
      for (const dy of [-1000, -120, -50, -8, 0, 8, 50, 120, 1000]) {
        const g = applyResize(pos, ORIG, dx, dy);
        for (const [key, value] of Object.entries(g)) {
          assert.ok(Number.isFinite(value), `${pos} dx=${dx} dy=${dy} → ${key}=${value}`);
        }
        assert.ok(g.x >= 0, `${pos} ${dx}/${dy} x=${g.x}`);
        assert.ok(g.y >= 0, `${pos} ${dx}/${dy} y=${g.y}`);
        assert.ok(g.width >= MIN_WIDTH);
        assert.ok(g.height >= MIN_HEIGHT);
        assert.ok(g.x + g.width <= STAGE_MAX + 1e-9, `${pos} ${dx}/${dy} 右边越界 ${g.x + g.width}`);
        assert.ok(g.y + g.height <= STAGE_MAX + 1e-9, `${pos} ${dx}/${dy} 下边越界 ${g.y + g.height}`);
      }
    }
  }
});

test('宽高滑杆和拉手柄走同一条边界（同一值改完必须一模一样）', () => {
  for (const v of [-10, 0, 1, 2, 3, 25, 79, 80, 81, 100, 500]) {
    const bySlider = clampSize('width', v, ORIG);
    const byHandle = applyResize('e', ORIG, v - ORIG.width, 0).width;
    assert.equal(bySlider, byHandle, `width=${v}`);
    const bySliderH = clampSize('height', v, ORIG);
    const byHandleH = applyResize('s', ORIG, 0, v - ORIG.height).height;
    assert.equal(bySliderH, byHandleH, `height=${v}`);
  }
  assert.equal(clampSize('width', 1, ORIG), MIN_WIDTH);
  assert.equal(clampSize('height', 1, ORIG), MIN_HEIGHT);
});

test('导入进来的超宽块（历史脏数据）也不会被钳出 NaN', () => {
  const g = applyResize('move', { x: 0, y: 0, width: 120, height: 80 }, 10, 10);
  assert.ok(Number.isFinite(g.x) && Number.isFinite(g.width));
  // 上限（100-宽）是负数时 min 胜出：块被按在舞台左边，只会更可移到范围内
  assert.deepEqual(g, { x: 0, y: 10, width: 120, height: 80 });
});
