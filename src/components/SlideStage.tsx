'use client';

import { useEffect, useRef, useState } from 'react';
import type { Slide, TextBlock } from '@/types/ppt';
import { blockStyle } from '@/components/blockStyle';
import { ImageBlockView } from '@/components/ImageBlockView';
import { VideoBlockView } from '@/components/VideoBlockView';
import { DESIGN_HEIGHT, DESIGN_WIDTH, computeStageLayout } from '@/lib/stage';
import { parseLocalKey } from '@/lib/slide-data';
import { cloudPublicUrl } from '@/lib/media-source';
import { storedVideoExt } from '@/lib/media-ext';
import { useLocalMaterial } from '@/lib/localMaterials';

interface SlideStageProps {
  slide: Slide;
  className?: string;
  /** 舞台元素（拖拽换算是按它的实际像素尺寸来的，编辑器需要持有引用） */
  stageRef?: React.RefObject<HTMLDivElement | null>;
  /** 缩略图里关掉自动播放，避免几十路视频同时解码 */
  animateVideo?: boolean;
  /**
   * 舞台在宿主盒子里的实际位置和像素尺寸。手机端把缩放手柄画在 `transform: scale()` 外面
   * 时要靠它换算，否则手柄会跟着舞台一起缩成 2.8 个物理像素、手指按不到。
   */
  onLayout?: (layout: StageLayout) => void;
  onClick?: (e: React.MouseEvent) => void;
  children?: React.ReactNode;
}

/** left/top 是相对宿主盒子的位移，w/h 已经乘过 scale，是屏幕上的真实像素 */
export interface StageLayout {
  scale: number;
  left: number;
  top: number;
  w: number;
  h: number;
}

export function SlideStage({
  slide,
  className = '',
  stageRef,
  animateVideo = true,
  onLayout,
  onClick,
  children,
}: SlideStageProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => setBox({ w: host.clientWidth, h: host.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const { scale, left, top } = computeStageLayout(box);

  // 回调存 ref：调用方传内联箭头函数也不会「报一次布局 → 父组件 setState → 再报一次」打转
  const report = useRef(onLayout);
  useEffect(() => {
    report.current = onLayout;
  });
  useEffect(() => {
    if (scale > 0) report.current?.({ scale, left, top, w: DESIGN_WIDTH * scale, h: DESIGN_HEIGHT * scale });
  }, [scale, left, top]);

  return (
    <div ref={hostRef} onClick={onClick} className={`overflow-hidden ${className}`}>
      {scale > 0 && (
        <div
          ref={(node) => {
            if (stageRef) stageRef.current = node;
          }}
          className="absolute bg-black"
          style={{
            width: DESIGN_WIDTH,
            height: DESIGN_HEIGHT,
            left,
            top,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
            boxShadow: '0 0 0 1px rgba(255,255,255,0.08)',
          }}
        >
          <StageBackground slide={slide} animateVideo={animateVideo} />
          {children}
        </div>
      )}
    </div>
  );
}

/** 引号包裹并转义，地址里的括号/引号不会截断 url token */
function cssUrl(value: string): string {
  return `url("${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")`;
}

/** 本地素材查库尚未就绪 / 本机没有该文件时的兜底色，与纯色默认一致 */
const FALLBACK_BG = '#1a1a2e';

function ImageBg({ url }: { url: string }) {
  return <div className="slide-bg image" style={{ backgroundImage: cssUrl(url) }} />;
}

function VideoBg({ elKey, url, animateVideo }: { elKey: string; url: string; animateVideo: boolean }) {
  return (
    <video
      key={elKey}
      className="slide-bg"
      src={url}
      autoPlay={animateVideo}
      muted
      loop
      playsInline
      preload={animateVideo ? 'auto' : 'metadata'}
    />
  );
}

/** 本地素材：deck 里只存 `local:<key>`，这里按 key 从 IndexedDB 解析成 blob: URL 再渲染 */
function LocalBg({ slideId, value, animateVideo }: { slideId: string; value: string; animateVideo: boolean }) {
  const key = parseLocalKey(value);
  const mat = useLocalMaterial(key);
  // pending / missing / error 都回退纯色：不渲染 <video src="">，也不发任何网络请求
  if (mat.status !== 'ready') return <div className="slide-bg" style={{ background: FALLBACK_BG }} />;
  const elKey = `${slideId}-${value}-${mat.url}`;
  return mat.kind === 'video' ? (
    <VideoBg elKey={elKey} url={mat.url} animateVideo={animateVideo} />
  ) : (
    <ImageBg url={mat.url} />
  );
}

function StageBackground({ slide, animateVideo }: { slide: Slide; animateVideo: boolean }) {
  const bg = slide.background;
  switch (bg.type) {
    case 'color':
      return <div className="slide-bg" style={{ background: bg.value }} />;
    case 'image':
      return <ImageBg url={bg.value} />;
    case 'video':
      return <VideoBg elKey={`${slide.id}-${bg.value}`} url={bg.value} animateVideo={animateVideo} />;
    case 'local':
      return <LocalBg slideId={slide.id} value={bg.value} animateVideo={animateVideo} />;
    case 'cloud': {
      // 公开读前缀没配好就回纯色：拿半截桶内路径去发请求，只会看到本站的 404
      const url = cloudPublicUrl(bg.value);
      if (!url) return <div className="slide-bg" style={{ background: FALLBACK_BG }} />;
      // 桶内路径的后缀就是唯一的类型线索：管理员传的视频背景要动，图片背景不该挂 <video>
      return storedVideoExt(bg.value) ? (
        <VideoBg elKey={`${slide.id}-${bg.value}`} url={url} animateVideo={animateVideo} />
      ) : (
        <ImageBg url={url} />
      );
    }
    default:
      return null;
  }
}

/** 只读渲染（播放页 + 缩略图）：字号是设计尺寸下的 px，由舞台整体缩放 */
export function SlideBlocks({ slide, lowres = false, animateVideo = true }: { slide: Slide; lowres?: boolean; animateVideo?: boolean }) {
  return (
    <>
      {/* 视频先画：和图片一起垫在文字底下，z-index 更高的仍然盖住文字 */}
      {slide.videoBlocks.map((block) => (
        <VideoBlockView key={block.id} block={block} lowres={lowres} animate={animateVideo} />
      ))}
      {slide.imageBlocks.map((block) => (
        <ImageBlockView key={block.id} block={block} lowres={lowres} />
      ))}
      {slide.textBlocks.map((block) => (
        <StaticBlock key={block.id} block={block} />
      ))}
    </>
  );
}

function StaticBlock({ block }: { block: TextBlock }) {
  return <div className="player-block" style={blockStyle(block)}>{block.text}</div>;
}
