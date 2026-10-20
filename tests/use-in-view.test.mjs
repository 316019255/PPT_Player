import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, useRef } from 'react';
import { renderToString } from 'react-dom/server';

import { useInView } from '../src/components/useInView.ts';

/**
 * 只看首屏取值：服务端渲染不跑 effect，所以 renderToString 出来的那一次就是
 * IntersectionObserver 回报之前页面会挂多少东西 —— 缩略图省内存省的就是这一刀。
 */
function Probe({ latching }) {
  const ref = useRef(null);
  return createElement('span', null, useInView(ref, latching) ? 'MOUNT' : 'GATE');
}

const render = (latching) => renderToString(createElement(Probe, { latching }));

class StubObserver {
  observe() {}
  disconnect() {}
}

test('有 IntersectionObserver 时首屏不挂载：几十页歌稿等到看得见才建 DOM', () => {
  const had = 'IntersectionObserver' in globalThis;
  globalThis.IntersectionObserver = StubObserver;
  try {
    assert.match(render(), /GATE/);
    assert.match(render(true), /GATE/, 'latching 也不该在回报之前挂载');
  } finally {
    if (!had) delete globalThis.IntersectionObserver;
  }
});

test('没有 IntersectionObserver 的老浏览器当作可见，别把缩略图刷成空白', () => {
  assert.ok(!('IntersectionObserver' in globalThis), '这条要跑在无 IO 的环境里');
  assert.match(render(), /MOUNT/);
});
