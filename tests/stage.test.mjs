import test from 'node:test';
import assert from 'node:assert/strict';

import { DESIGN_HEIGHT, DESIGN_WIDTH, computeStageLayout } from '../src/lib/stage.ts';

const approx = (value, expected) => assert.ok(Math.abs(value - expected) < 1e-9, `${value} != ${expected}`);

test('设计尺寸就是 16:9 的一块固定画布', () => {
  assert.equal(DESIGN_WIDTH / DESIGN_HEIGHT, 16 / 9);
});

test('宿主与设计尺寸同比例时不缩放、不留边', () => {
  const l = computeStageLayout({ w: DESIGN_WIDTH, h: DESIGN_HEIGHT });
  assert.equal(l.scale, 1);
  assert.equal(l.left, 0);
  assert.equal(l.top, 0);

  const big = computeStageLayout({ w: 1920, h: 1080 });
  approx(big.scale, 1.5);
  approx(big.left, 0);
  approx(big.top, 0);
});

test('宿主更宽时按高度受限缩放并水平居中', () => {
  const l = computeStageLayout({ w: 1600, h: 720 });
  approx(l.scale, 1);
  approx(l.left, 160);
  approx(l.top, 0);
});

test('宿主更高时按宽度受限缩放并垂直居中', () => {
  const l = computeStageLayout({ w: 800, h: 1000 });
  approx(l.scale, 0.625);
  approx(l.left, 0);
  approx(l.top, 275);
});

test('等比缩放保持字号与位置同步，不会只缩一个方向', () => {
  for (const box of [{ w: 640, h: 360 }, { w: 3000, h: 400 }, { w: 375, h: 667 }]) {
    const { scale } = computeStageLayout(box);
    approx(scale, Math.min(box.w / DESIGN_WIDTH, box.h / DESIGN_HEIGHT));
    assert.ok(scale > 0 && Number.isFinite(scale));
  }
});

test('尚未测量到尺寸时返回 0，交给调用方跳过渲染', () => {
  assert.deepEqual(computeStageLayout({ w: 0, h: 0 }), { scale: 0, left: 0, top: 0 });
  assert.equal(computeStageLayout({ w: -100, h: 50 }).scale, 0);
  assert.equal(computeStageLayout({ w: NaN, h: 50 }).scale, 0);
});
