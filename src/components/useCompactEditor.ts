'use client';

import { useSyncExternalStore } from 'react';

/**
 * 窄或矮的视口＝手机端布局，全站只有这一处判定：窄屏（≤767px，即 Tailwind 的 md）或矮屏（≤559px）。
 * 编辑器、列表页、放映页共用它，别让两套判断各走各的。
 * 加「矮」是因为横屏手机常有 844 CSS px 宽，只看宽度会把它判成桌面，
 * 而横屏正是用户的主战场。
 * 布局本可以纯靠 CSS 变体，但「给不给键盘、挂不挂 8 个手柄、顶栏要不要折进 ⋯」是行为，JS 必须知道答案。
 */
const COMPACT_QUERY = '(max-width: 767px), (max-height: 559px)';

function subscribe(onChange: () => void): () => void {
  const mq = window.matchMedia(COMPACT_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

function getSnapshot(): boolean {
  return window.matchMedia(COMPACT_QUERY).matches;
}

// 服务端没有视口，按桌面渲染；客户端 hydration 时立刻换成真实结果
function getServerSnapshot(): boolean {
  return false;
}

export function useCompactEditor(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
