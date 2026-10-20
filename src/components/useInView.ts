'use client';

import { useEffect, useState, type RefObject } from 'react';

/**
 * 只在格子接近可视区时才读预览，滚出去就释放。
 * 库里几百个素材时，一次性挂上去会把几百张预览图同时解码进内存；
 * IntersectionObserver 缺位的老浏览器直接当作可见（行为等同不懒加载）。
 * latching=true 用于在线缩略图：请求过一次就别卸载，否则来回滚会反复走网络、格子闪白。
 */
export function useInView(ref: RefObject<HTMLElement | null>, latching = false): boolean {
  const [inView, setInView] = useState(() => typeof IntersectionObserver === 'undefined');

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      const visible = entries[0]?.isIntersecting ?? false;
      if (visible) setInView(true);
      else if (!latching) setInView(false);
    }, { rootMargin: '160px' });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, latching]);

  return inView;
}
