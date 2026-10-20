'use client';

import { memo, useRef } from 'react';
import type { Slide } from '@/types/ppt';
import { SlideBlocks, SlideStage } from '@/components/SlideStage';
import { useInView } from '@/components/useInView';

interface SlideThumbProps {
  slide: Slide;
  /** 外层必须自己是定位盒（relative 或 absolute），舞台靠 absolute inset-0 铺满它 */
  className: string;
}

/**
 * 只读缩略图：屏幕外的页不挂舞台。
 * 几十页的歌稿本以前每页都挂一套完整 SlideStage + SlideBlocks —— 一套 block DOM、
 * 一个 ResizeObserver、每个本地图块还各订阅一次 IndexedDB，而屏幕上只看得见七八页。
 * latching：滚见过的页不再卸载，否则来回拖动会反复重建 DOM 和重读库。
 *
 * memo 的前提是 store 的更新方式：改某一页时只有那一页的 slide 是新对象，其余按身份原样保留，
 * 所以改一个字只重渲染正在改的那一页，而不是整条缩略图栏。
 */
export const SlideThumb = memo(function SlideThumb({ slide, className }: SlideThumbProps) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, true);

  return (
    <div ref={ref} className={className}>
      {inView && (
        <SlideStage slide={slide} className="absolute inset-0" animateVideo={false}>
          <SlideBlocks slide={slide} lowres />
        </SlideStage>
      )}
    </div>
  );
});
