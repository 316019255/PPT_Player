'use client';

import { useEffect, useState } from 'react';

/**
 * 手机浏览器里的键盘不遵守同一套规则：Android 可能只缩视觉视口，iOS 干脆不动布局视口，
 * 于是「吸底」的抽屉会被键盘盖住、手指看不到自己在打什么。
 * 这里把键盘占掉的那段高度量出来，交给布局当作底部内边距，两边行为就一致了。
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const read = () => {
      // 视觉视口比布局视口矮多少，就是键盘 + 输入法工具条占掉多少
      const next = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      setInset((prev) => (Math.abs(prev - next) < 2 ? prev : next));
    };
    read();
    vv.addEventListener('resize', read);
    vv.addEventListener('scroll', read);
    return () => {
      vv.removeEventListener('resize', read);
      vv.removeEventListener('scroll', read);
    };
  }, []);

  return inset;
}

/** 横屏判定只看视口比例，不看宽度：手机端主战场是横屏，而横屏时宽度往往已经过了桌面断点 */
export function useLandscapeViewport(): boolean {
  const [landscape, setLandscape] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(orientation: landscape)');
    const sync = () => setLandscape(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  return landscape;
}
