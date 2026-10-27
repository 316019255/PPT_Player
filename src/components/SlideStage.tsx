'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Background, Slide, TextBlock } from '@/types/ppt';
import { blockStyle } from '@/components/blockStyle';
import { ImageBlockView } from '@/components/ImageBlockView';
import { VideoBlockView } from '@/components/VideoBlockView';
import { DESIGN_HEIGHT, DESIGN_WIDTH, computeStageLayout } from '@/lib/stage';
import { parseLocalKey } from '@/lib/slide-data';
import { BG_LAYER_BELOW, BG_LAYER_TOP } from '@/lib/block-geometry';
import { cloudPublicUrl } from '@/lib/media-source';
import { storedVideoExt } from '@/lib/media-ext';
import { backgroundLayerId, isStaticBackground, videoSourceId, videoSourceUrl } from '@/lib/slide-background';
import { holdVideo } from '@/lib/video-warm';
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

/**
 * 淡入时长：新画面盖满旧画面用掉多久。
 * 底层的旧画面全程保持 1.0，所以屏幕任何时候都被不透明的一层铺满 —— 不会有任何亮度凹陷，
 * 这个值只决定「两个画面重叠的残影期」有多长：长了看得出是溶解，短了接近硬切。
 */
const CROSSFADE = 0.8;

/**
 * 提前点火的余量：tick 间隔 + `play()` 落地 + React 提交透明度，实测约 0.1 秒。
 * 不留余量的话淡入层还没盖满，底层就已经回卷到开头，开头画面会在半透明底下透出来一点点。
 */
const HANDOFF_LEAD = 0.35;

/**
 * 提前这么多秒把隐藏层倒回开头，让 seek 先落定（远程 mp4 的 seek 可能要重开一个 range 请求，
 * 慢设备上不是零成本）。只 seek、不 play —— 提前播起来等于把片头这几秒跳过去不看。
 */
const PREWARM = 4;

/**
 * 双 video 无缝循环：底层不动，只让新画面淡入盖上来。
 * 单条 `<video loop>` 回到开头时会黑闪（画面清空重解码）且硬切突兀；
 * 片尾前 PREWARM 秒把藏着的那条倒回 0，还剩 `CROSSFADE + HANDOFF_LEAD` 秒时让它播起来，
 * 真出画面了才 0→1 淡入 —— 它淡入期间旧那条仍满不透明度垫在下面，回卷发生在一层不透明的画面底下。
 * 淡满后才把旧条的透明度归零并让它停：所以全程没有「两层同时衰减」会暗一下的那道坑。
 */
function LoopingVideo({ url, onReady, onDead }: { url: string; onReady: () => void; onDead: () => void }) {
  const aRef = useRef<HTMLVideoElement>(null);
  const bRef = useRef<HTMLVideoElement>(null);
  // 盖在最上面、负责播完整一轮的那条
  const [show, setShow] = useState<'a' | 'b'>('a');
  const showRef = useRef<'a' | 'b'>('a');
  // false = 淡入还没盖满，底下那条继续保持满不透明度垫底（屏幕不能出现任何半透明的空档）
  const [settled, setSettled] = useState(true);
  // 藏着的那条 play() 还没落地时挡住重复交接
  const handoffRef = useRef(false);
  // 已经提前倒回开头的那条，避免每 120ms 重发一次 seek
  const preparedRef = useRef<HTMLVideoElement | null>(null);
  // 刚被盖住的那条：让它播到回卷、在满不透明的新画面底下停掉，避免淡出途中定帧
  const fadingOutRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (settled) return;
    const settle = window.setTimeout(() => setSettled(true), CROSSFADE * 1000 + 60);
    return () => window.clearTimeout(settle);
  }, [settled, show]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const fading = fadingOutRef.current;
      // currentTime 掉回 1 秒内 = 它已经在看不见的地方 loop 过开头了，可以下班
      if (fading && !fading.paused && fading.currentTime < 1) {
        fading.pause();
        fadingOutRef.current = null;
      }
      const cur = (showRef.current === 'a' ? aRef : bRef).current;
      const next = (showRef.current === 'a' ? bRef : aRef).current;
      // duration 不是有限数（异常流）或备用条报错：退回浏览器原生 loop，不交接
      if (!cur || !next || cur.paused || next.error || !isFinite(cur.duration)) return;
      const timeLeft = cur.duration - cur.currentTime;
      if (preparedRef.current !== next && timeLeft <= PREWARM) {
        preparedRef.current = next;
        next.currentTime = 0;
      }
      // 极短素材撑不出交接窗口：阈值最多到片长一半，保证每条每轮都能对上位
      if (handoffRef.current || timeLeft > Math.min(CROSSFADE + HANDOFF_LEAD, cur.duration / 2)) return;
      handoffRef.current = true;
      if (next.currentTime !== 0 || next.seeking) next.currentTime = 0;
      // 等 play() 真出画面再淡入：新画面永远不会停在黑帧或残帧上
      next.play().then(
        () => {
          const other = showRef.current === 'a' ? 'b' : 'a';
          showRef.current = other;
          setShow(other);
          setSettled(false);
          fadingOutRef.current = cur;
          preparedRef.current = null;
          handoffRef.current = false;
        },
        () => {
          handoffRef.current = false;
        },
      );
    }, 120);
    return () => window.clearInterval(timer);
  }, []);

  // 淡入期间两层都是 1.0：上面那条从 0 走到 1，下面那条全程不衰减，所以亮度不凹陷
  const opacityFor = (which: 'a' | 'b') => (show === which || !settled ? 1 : 0);
  // 背景两档都在内容块最低层号（1）底下，抬上去就会把正文糊住
  const layerFor = (which: 'a' | 'b') => (show === which ? BG_LAYER_TOP : BG_LAYER_BELOW);

  return (
    <>
      <video
        ref={aRef}
        className="slide-bg"
        src={url}
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        // 只认 A 的首帧：B 是藏着备用的那条，它先有画面不代表屏幕上这一条能看
        onLoadedData={onReady}
        onError={onDead}
        style={{ opacity: opacityFor('a'), zIndex: layerFor('a'), transition: `opacity ${CROSSFADE}s linear` }}
      />
      <video
        ref={bRef}
        className="slide-bg"
        src={url}
        muted
        loop
        playsInline
        preload="auto"
        style={{ opacity: opacityFor('b'), zIndex: layerFor('b'), transition: `opacity ${CROSSFADE}s linear` }}
      />
    </>
  );
}

/**
 * 背景的唯一入口。`animateVideo` 由调用方定死（放映/编辑器要动，缩略图不要），
 * 在这个实例的整个生命周期里不会翻转，所以两个分支各自持有自己的 hooks 也不构成条件 hooks。
 */
function StageBackground({ slide, animateVideo }: { slide: Slide; animateVideo: boolean }) {
  if (!animateVideo) return <StaticBackground slide={slide} />;
  return <BackgroundStack slide={slide} />;
}

/**
 * 跨页存活的背景层栈：**一层 = 一种背景身份**，层的生死按身份算，不按页号算。
 *
 * 为什么要按身份：以前 `key` 里带着 slide.id，翻页等于把整组 `<video>` 重挂一遍 ——
 * 于是每次翻到下一页都从头开始播（歌词一页一句时最明显：同一支视频被反复打断），
 * 而且新元素在首帧之前是一块黑。本机素材还多付一次 revoke + 重读 IndexedDB。
 *
 * 三条规矩：
 * - 同一个身份跨页 → 同一个 DOM 元素继续播，不淡入、不重挂、不回 0 秒。
 * - 换身份 → 新层先按着不亮（opacity 0），旧层继续满不透明度垫在下面；
 *   新层真出画面了才 0→1 盖上来，淡满后旧层下班（字节转交给预热池）。
 *   在那之前屏幕上停在上一页的视频上，不是黑屏 —— 首帧慢几十秒也只是多停几十秒。
 * - 纯色/图片也算一层（不然「纯色页 → 视频页」那一帧底色就没了，淡入底下是黑的）；
 *   但两层都静态时硬切不溶解，编辑器里拖色板要立刻看到颜色。
 */
function BackgroundStack({ slide }: { slide: Slide }) {
  const bg = slide.background;
  const id = backgroundLayerId(bg);
  const [layers, setLayers] = useState<Layer[]>([]);
  const top = layers[layers.length - 1];
  const topId = top?.id ?? '';

  // 层是**按背景身份派生**的，不放在 effect 里等下一帧：翻页那一帧新层就该开始加载，
  // 早一帧就是一帧的字节。渲染中更新本组件的 state 是 React 认可的写法，
  // 它会立刻重跑这一遍渲染，不会先把「只有旧层」的画面画到屏幕上。
  if (topId !== id) {
    // 身份为空 = 这一页连背景都没有（未知类型 / 空值）：整叠撤掉，
    // 否则上一页的视频会盖在这一页的背景上。
    if (!id) {
      setLayers([]);
    } else {
      // 垫底只留最近一条**真出过画**的层：还没出画的那条是透明的，拿它垫底等于垫了块黑；
      // 连着翻几页慢视频时，按「最近一条」留还会攒出两层都画不出东西的栈。
      const bottom = [...layers].reverse().find((l) => l.painted) ?? null;
      // 静态层「本来就没有需要等的画面」，这两种情况直接画满、不淡入：
      // 底下没有旧层可垫（淡入就是 0.8 秒黑），或垫底那层也是静态（溶解会把编辑器的色板拖成糊）
      const litImmediately = isStaticBackground(bg) && (!bottom || isStaticBackground(bottom.bg));
      setLayers(litImmediately ? [{ bg, id, painted: true }] : [...(bottom ? [bottom] : []), { bg, id, painted: false }]);
    }
  }

  const topLit = !!top && (top.painted || !!top.dead);

  /** 新层报到「真出画了」。只有顶层的报到算数：被撤掉的旧层迟到的首帧不该改现在的栈 */
  const markPainted = useCallback((layerId: string) => {
    setLayers((prev) => {
      const head = prev[prev.length - 1];
      if (!head || head.id !== layerId || head.painted) return prev;
      return prev.map((l) => (l.id === layerId ? { ...l, painted: true, dead: false } : l));
    });
  }, []);

  /** 片源报错：等下去也不会有画面，按「能看」放行 —— 淡满后让垫底层下班，坏素材不该钉在正确的文字底下 */
  const markDead = useCallback((layerId: string) => {
    setLayers((prev) => {
      const head = prev[prev.length - 1];
      if (!head || head.id !== layerId || head.dead) return prev;
      return prev.map((l) => (l.id === layerId ? { ...l, dead: true } : l));
    });
  }, []);

  // 淡满之后旧层下班
  useEffect(() => {
    if (!topLit || layers.length < 2) return;
    const t = window.setTimeout(
      () => setLayers((prev) => (prev.length > 1 ? prev.slice(-1) : prev)),
      CROSSFADE * 1000 + 150,
    );
    return () => window.clearTimeout(t);
  }, [topLit, topId, layers.length]);

  return (
    <>
      {layers.map((layer, i) => (
        <BackgroundLayer
          key={layer.id}
          bg={layer.bg}
          id={layer.id}
          top={i === layers.length - 1}
          lit={layer.painted || !!layer.dead}
          onReady={markPainted}
          onDead={markDead}
        />
      ))}
    </>
  );
}

interface Layer {
  /** 加层那一页的背景：旧层要一直画到淡满，不能跟着新页一起换 */
  bg: Background;
  id: string;
  /** 真出画了：视频首帧 / 图解出来 / 底色画满。淡入和撤垫底都只认这个 */
  painted: boolean;
  /** `<video>` 自己报错，这支片源永远画不出画面 */
  dead?: boolean;
}

/** 一层的样式：顶层负责淡入，垫底那条全程满不透明度（所以屏幕任何时候都被一层铺满） */
function layerStyle(top: boolean, lit: boolean): React.CSSProperties {
  return {
    opacity: top ? (lit ? 1 : 0) : 1,
    // 背景两档都在内容块最低层号（1）底下，抬上去就会把正文糊住
    zIndex: top ? BG_LAYER_TOP : BG_LAYER_BELOW,
    transition: top ? `opacity ${CROSSFADE}s linear` : 'none',
  };
}

function LocalLayer({
  bg,
  id,
  style,
  onReady,
  onDead,
}: {
  bg: Background;
  id: string;
  style: React.CSSProperties;
  onReady: (id: string) => void;
  onDead: (id: string) => void;
}) {
  const mat = useLocalMaterial(parseLocalKey(bg.value));
  const isVideo = mat.status === 'ready' && mat.kind === 'video';

  useEffect(() => {
    // 视频那条由自己的首帧事件报到；其余（缺素材 / 读库失败 / 其实是图片）这一层已经画满了，
    // 必须立刻报到 —— 否则层栈会永远等一个永远不会来的首帧，把上一页钉在屏幕上。
    if (!isVideo && mat.status !== 'pending') onReady(id);
  }, [isVideo, mat.status, id, onReady]);

  if (isVideo) return <LayerBody id={id} url={mat.url} style={style} onReady={onReady} onDead={onDead} />;
  if (mat.status === 'ready') {
    return (
      <div className="slide-bg" style={style}>
        <ImageBg url={mat.url} />
      </div>
    );
  }
  // 还在读库：这一层什么都不画，让上一页继续垫着；读不出来就按纯色兜底
  if (mat.status === 'pending') return null;
  return <div className="slide-bg" style={{ ...style, background: FALLBACK_BG }} />;
}

/** 层的分派：本机素材要查库才知道是图还是视频；有片源身份的交给无缝循环的双元素播；剩下的静态自己画满 */
function BackgroundLayer({
  bg,
  id,
  top,
  lit,
  onReady,
  onDead,
}: {
  bg: Background;
  id: string;
  top: boolean;
  lit: boolean;
  onReady: (id: string) => void;
  onDead: (id: string) => void;
}) {
  const style = layerStyle(top, lit);
  // 只有真挂 `<video>` 的两支会报错；静态支画不出图时自己按底色画满，用不着 onDead
  if (bg.type === 'local') return <LocalLayer bg={bg} id={id} style={style} onReady={onReady} onDead={onDead} />;
  if (videoSourceId(bg)) return <LayerBody id={id} url={videoSourceUrl(bg, null)} style={style} onReady={onReady} onDead={onDead} />;
  return <StaticLayer bg={bg} id={id} style={style} onReady={onReady} />;
}

/** 图片那一支的地址：纯色、拼不出公开读前缀的云端路径、桶里其实是视频的，都回 '' 按底色画 */
function staticImageUrl(bg: Background): string {
  switch (bg.type) {
    case 'image':
      return bg.value;
    case 'cloud':
      return storedVideoExt(bg.value) ? '' : cloudPublicUrl(bg.value);
    default:
      return '';
  }
}

/** 地址都拿不到时垫的底色：纯色页用自己那色，其余按兜底（和素材读不到时同一档） */
function staticFallbackColor(bg: Background): string {
  return bg.type === 'color' ? bg.value : FALLBACK_BG;
}

/**
 * 图片解出来没有：没解出来之前这层是透明的，准它淡入就等于让用户看一遍黑底。
 * 读失败要单独认：那层按底色画满（有画面），不是「图已经出来了」。
 */
function useImagePainted(url: string): 'pending' | 'painted' | 'failed' {
  const [state, setState] = useState<'pending' | 'painted' | 'failed'>(url ? 'pending' : 'painted');
  useEffect(() => {
    if (!url) return;
    let live = true;
    const img = new Image();
    img.onload = () => {
      if (live) setState('painted');
    };
    img.onerror = () => {
      if (live) setState('failed');
    };
    img.src = url;
    return () => {
      live = false;
    };
  }, [url]);
  return state;
}

function StaticLayer({
  bg,
  id,
  style,
  onReady,
}: {
  bg: Background;
  id: string;
  style: React.CSSProperties;
  onReady: (id: string) => void;
}) {
  const url = staticImageUrl(bg);
  const state = useImagePainted(url);
  useEffect(() => {
    // 图出来了、图坏了（改画底色）、本来就没地址 —— 都算这层有画面，可以淡入并放垫底层下班
    if (state !== 'pending') onReady(id);
  }, [state, id, onReady]);
  if (!url || state === 'failed') return <div className="slide-bg" style={{ ...style, background: staticFallbackColor(bg) }} />;
  return (
    <div className="slide-bg" style={style}>
      <ImageBg url={url} />
    </div>
  );
}

/** 层的实体：地址已经拿到，交给无缝循环的双元素播，并向预热池声明「这条正在屏幕上」 */
function LayerBody({
  id,
  url,
  style,
  onReady,
  onDead,
}: {
  id: string;
  url: string;
  style: React.CSSProperties;
  onReady: (id: string) => void;
  onDead: (id: string) => void;
}) {
  // 池和屏幕对一个 URL 不会同时持有：挂上就让位，摘下就交还（换页翻回去时不用重头再拉）
  useEffect(() => holdVideo(url), [url]);
  return (
    <div className="slide-bg" style={style}>
      <LoopingVideo url={url} onReady={() => onReady(id)} onDead={() => onDead(id)} />
    </div>
  );
}

/** 静态档（缩略图）：一页一元素，不跨页存活、不淡入 —— 几十页同时挂层栈会把浏览器拖垮 */
function StaticBackground({ slide }: { slide: Slide }) {
  const bg = slide.background;
  switch (bg.type) {
    case 'color':
      return <div className="slide-bg" style={{ background: bg.value }} />;
    case 'image':
      return <ImageBg url={bg.value} />;
    case 'video':
      return <video className="slide-bg" src={bg.value} muted playsInline preload="metadata" />;
    case 'local':
      return <LocalStatic bg={bg} />;
    case 'cloud': {
      const url = cloudPublicUrl(bg.value);
      if (!url) return <div className="slide-bg" style={{ background: FALLBACK_BG }} />;
      // 桶内路径的后缀就是唯一的类型线索：视频背景不该在缩略图里挂满解码器，图片背景不该挂 <video>
      return storedVideoExt(bg.value) ? (
        <video className="slide-bg" src={url} muted playsInline preload="metadata" />
      ) : (
        <ImageBg url={url} />
      );
    }
    default:
      return null;
  }
}

function LocalStatic({ bg }: { bg: Background }) {
  const mat = useLocalMaterial(parseLocalKey(bg.value));
  // pending / missing / error 都回退纯色：不渲染 <video src="">，也不发任何网络请求
  if (mat.status !== 'ready') return <div className="slide-bg" style={{ background: FALLBACK_BG }} />;
  return mat.kind === 'video' ? (
    <video className="slide-bg" src={mat.url} muted playsInline preload="metadata" />
  ) : (
    <ImageBg url={mat.url} />
  );
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
