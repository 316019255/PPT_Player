'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Slide } from '@/types/ppt';
import { SlideBlocks, SlideStage } from '@/components/SlideStage';
import NoticeBar, { type Notice } from '@/components/NoticeBar';
import RowMenu, { type RowMenuItem } from '@/components/RowMenu';
import SheetOverlay from '@/components/SheetOverlay';
import { useCompactEditor } from '@/components/useCompactEditor';
import { swipeSide } from '@/lib/play-gesture';
import { preloadSlideMedia } from '@/lib/preload-media';
import { nextVideoSourceUrl, videoSourceId } from '@/lib/slide-background';
import { warmVideo } from '@/lib/video-warm';

interface Props {
  presentationId: number;
  title: string;
  slides: Slide[];
  startSlide?: number;
  /** 后台预览别人的稿子时「返回」要回列表，不是回自己的 dashboard */
  backHref?: string;
  /**
   * 只读：把「编辑」这一类入口整个拿掉（不是 disabled）。
   * 管理员预览的是别人的 deck，`/editor/{id}` 按 user_id 查，进去就是 404 ——
   * 给一个点了没反应的键等于没有键。
   */
  readOnly?: boolean;
}

const HINT_MS = 3500;

/**
 * 一次划动除了 touchend 还会补一个合成 click，不隔掉就会翻两页。
 * 用时间戳而不是布尔标志：preventDefault 能不能吃掉那个 click，各家浏览器不一致。
 */
const CLICK_GRACE_MS = 400;

const NO_FULLSCREEN: Notice = {
  tone: 'warn',
  text: '此浏览器不支持整屏放映，已用窗口放映；点屏幕左右或左右滑动就能翻页。',
};

/** 在本页停留多久才去热下一条视频片源（见放映页里的预热 effect） */
const WARM_DELAY_MS = 2000;

/** 手机端抽屉里的遥控器说明；桌面端还是那一发 alert，不动 */
const REMOTE_HELP: [string, string][] = [
  ['👆 本屏翻页', '点屏幕左半 / 右半，或者左右滑动。'],
  ['🔵 蓝牙 / 电视遥控器', '已自动支持，直接按频道 ± 翻页。'],
  ['🖥 Chrome 投屏遥控器', '需浏览器支持 Presentation API，按这里的按键发起。'],
  ['⌨️ 键盘', '空格 / → 下一页 · ← / PgUp 上一页 · Home/End 跳首末 · F 全屏'],
];

/** 翻页笔/键盘在输入框里时不该抢按键 */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el?.tagName) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

/** Presentation API（Chrome 手机遥控器）在非标准接口上，DOM lib 里没有 */
interface PresentationNav {
  presentation?: {
    request?: (url: string) => Promise<unknown>;
    receiver?: {
      getConnection?: () => Promise<{
        onmessage: ((ev: MessageEvent) => void) | null;
        onclose: (() => void) | null;
        close?: () => void;
      }>;
      setOnReceiverConnectionAvailable?: (cb: () => void) => void;
    };
  };
}

export default function PlayerClient({
  presentationId,
  title,
  slides,
  startSlide = 0,
  backHref = '/dashboard',
  readOnly = false,
}: Props) {
  const router = useRouter();
  const compact = useCompactEditor();
  const total = slides.length;
  const [current, setCurrent] = useState(() => Math.max(0, Math.min(startSlide, total - 1)));
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [hintVisible, setHintVisible] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [remoteSheet, setRemoteSheet] = useState(false);
  const [jumpOpen, setJumpOpen] = useState(false);
  /** 按下去没反应的键等于没有键：先问浏览器答不答应，不答应就不把「全屏」摆出来 */
  const [fsSupported, setFsSupported] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const hintTimer = useRef<number | null>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const lastSwipeAt = useRef(0);

  const clamp = useCallback((index: number) => Math.max(0, Math.min(index, total - 1)), [total]);
  const goNext = useCallback(() => setCurrent((c) => clamp(c + 1)), [clamp]);
  const goPrev = useCallback(() => setCurrent((c) => clamp(c - 1)), [clamp]);
  const goHome = useCallback(() => setCurrent(0), []);
  const goEnd = useCallback(() => setCurrent(total - 1), [total]);

  const showHint = useCallback(() => {
    setHintVisible(true);
    if (hintTimer.current !== null) window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHintVisible(false), HINT_MS);
  }, []);

  const exitFullscreen = useCallback(async () => {
    if (!document.fullscreenElement) return;
    try {
      await document.exitFullscreen();
    } catch {
      setIsFullscreen(false);
    }
  }, []);

  const enterFullscreen = useCallback(async () => {
    const el = containerRef.current;
    if (!el || document.fullscreenElement) return;
    try {
      await el.requestFullscreen();
      // 有的浏览器（iOS Safari 16.4+）不 reject，只是根本没进全屏：靠回读才看得出来
      if (!document.fullscreenElement) setNotice(NO_FULLSCREEN);
    } catch {
      setNotice(NO_FULLSCREEN);
    }
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void exitFullscreen();
    else void enterFullscreen();
  }, [enterFullscreen, exitFullscreen]);

  const requestRemote = useCallback(() => {
    const presentation = (navigator as Navigator & PresentationNav).presentation;
    if (presentation?.request) presentation.request(window.location.href).catch(() => {});
  }, []);

  useEffect(() => {
    const el = containerRef.current ?? document.documentElement;
    setFsSupported(document.fullscreenEnabled !== false && typeof el.requestFullscreen === 'function');
  }, []);

  useEffect(() => {
    const onChange = () => {
      const fullscreen = !!document.fullscreenElement;
      setIsFullscreen(fullscreen);
      // 进全屏时把快捷键提示出来一次，几秒后自己淡掉
      if (fullscreen) showHint();
      else setHintVisible(false);
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [showHint]);

  useEffect(() => {
    return () => {
      if (hintTimer.current !== null) window.clearTimeout(hintTimer.current);
    };
  }, []);

  // 兼容所有 USB 翻页笔的键码；只监听 window，避免同一次按键翻两页
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;

      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
        case ' ':
        case 'PageDown':
        case 'Next':
        case 'n':
        case 'N':
        case 'j':
        case 'J':
          e.preventDefault();
          goNext();
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'PageUp':
        case 'Prior':
        case 'p':
        case 'P':
        case 'k':
        case 'K':
        case 'Backspace':
          e.preventDefault();
          goPrev();
          break;
        case 'Home':
        case '1':
          e.preventDefault();
          goHome();
          break;
        case 'End':
        case '0':
          e.preventDefault();
          goEnd();
          break;
        case 'f':
        case 'F':
        case 'F11':
          e.preventDefault();
          toggleFullscreen();
          break;
        case 'Escape':
        case 'q':
        case 'Q':
          if (document.fullscreenElement) {
            e.preventDefault();
            void exitFullscreen();
          }
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [goNext, goPrev, goHome, goEnd, toggleFullscreen, exitFullscreen]);

  // Media Session API — 蓝牙/电视遥控器、系统媒体键
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;

    ms.metadata = new MediaMetadata({
      title,
      artist: `PPT 幻灯片 ${current + 1}/${total}`,
      album: '在线 PPT 播放器',
    });
    ms.playbackState = 'playing';

    ms.setActionHandler('nexttrack', () => goNext());
    ms.setActionHandler('previoustrack', () => goPrev());
    ms.setActionHandler('seekto', (details) => {
      if (details.fastSeek && typeof details.seekTime === 'number') setCurrent(clamp(Math.round(details.seekTime)));
    });
    ms.setActionHandler('stop', () => void exitFullscreen());

    return () => {
      for (const action of ['nexttrack', 'previoustrack', 'seekto', 'stop'] as const) {
        ms.setActionHandler(action, null);
      }
    };
  }, [current, total, title, goNext, goPrev, clamp, exitFullscreen]);

  // Presentation API — Chrome 手机作为遥控器（旧版 receiver 接口）
  useEffect(() => {
    const receiver = (navigator as Navigator & PresentationNav).presentation?.receiver;
    if (!receiver?.getConnection || !receiver.setOnReceiverConnectionAvailable) return;

    type Connection = Awaited<ReturnType<NonNullable<typeof receiver.getConnection>>>;
    let connection: Connection | null = null;

    const accept = () => {
      receiver.getConnection?.().then((port) => {
        connection = port;
        port.onmessage = (ev: MessageEvent) => {
          const cmd: unknown = ev.data;
          if (cmd === 'next') goNext();
          else if (cmd === 'prev') goPrev();
          else if (cmd === 'first') goHome();
          else if (cmd === 'last') goEnd();
          else if (typeof cmd === 'number') setCurrent(clamp(cmd));
        };
        port.onclose = () => {
          connection = null;
        };
      });
    };
    receiver.setOnReceiverConnectionAvailable?.(accept);

    return () => {
      try {
        connection?.close?.();
      } catch {
        // 断开遥控器不该影响放映
      }
    };
  }, [goNext, goPrev, goHome, goEnd, clamp]);

  // 翻到新一页后，把前后要用的网络图片提前递进缓存（effect 在绘制之后跑，
  // 不会跟正在屏幕上这一页抢渲染时间）。往前两页是因为连按翻页笔比一趟网络往返快。
  useEffect(() => {
    for (const index of [current + 1, current + 2, current - 1]) {
      const neighbor = slides[index];
      if (neighbor) preloadSlideMedia(neighbor);
    }
  }, [current, slides]);

  // 背景视频只提前热「下一条不同的片源」：同一条视频连铺几页是常态，那种页之间不用预热。
  // 延时是因为这一页自己正在起播、正在抢带宽；用户在这一页停留不足这么久就翻页，
  // 说明他翻得比下载快，那也不必替一个还没到的页花钱。
  useEffect(() => {
    const url = nextVideoSourceUrl(slides, current, videoSourceId(slides[current]?.background));
    if (!url) return;
    const t = window.setTimeout(() => warmVideo(url), WARM_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [current, slides]);

  const slide = slides[current];

  const phoneMenu: RowMenuItem[] = [
    { kind: 'label', label: title },
    ...(readOnly
      ? []
      : ([
          { kind: 'action', label: '✏️ 编辑此叠', onClick: () => router.push(`/editor/${presentationId}`) },
        ] as RowMenuItem[])),
    {
      kind: 'action',
      label: '📱 遥控器说明',
      onClick: () => {
        requestRemote();
        setRemoteSheet(true);
      },
    },
    { kind: 'divider' },
    {
      kind: 'action',
      label: '⏹ 退出放映',
      onClick: () => void exitFullscreen().then(() => router.replace(backHref)),
    },
  ];

  const handleStageClick = (e: React.MouseEvent) => {
    // 桌面窗口态点屏幕本来不翻页（那是给投屏/放映时的），只解锁手机端
    if (!compact && !isFullscreen) return;
    if (Date.now() - lastSwipeAt.current < CLICK_GRACE_MS) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (e.clientX - rect.left < rect.width / 2) goPrev();
    else goNext();
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    touchStart.current = t ? { x: t.clientX, y: t.clientY } : null;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    const from = touchStart.current;
    touchStart.current = null;
    const t = e.changedTouches[0];
    if (!from || !t) return;
    const side = swipeSide(t.clientX - from.x, t.clientY - from.y);
    if (!side) return;
    lastSwipeAt.current = Date.now();
    if (side === 'next') goNext();
    else goPrev();
  };

  return (
    <div ref={containerRef} className="w-full h-dvh bg-black overflow-hidden relative">
      {/* 手势层：SlideStage 只往外转发 onClick，touch 事件塞给它会静默丢掉，所以自己套一层接。
          这层和原来那个 absolute inset-0 是同一片区域，点击换算的 currentTarget 尺寸没变。 */}
      <div
        className="absolute inset-0 touch-none select-none"
        onClick={handleStageClick}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        <SlideStage slide={slide} className="relative h-full w-full">
          <SlideBlocks slide={slide} />
        </SlideStage>
      </div>

      {/* 手机端顶栏：桌面那四键一行在 356px 上会把最右边的键挤出屏幕外，所以编辑/遥控器折进 ⋯ */}
      {!isFullscreen && compact && (
        <>
          <div className="absolute top-0 left-0 right-0 p-3 flex items-center gap-2 bg-gradient-to-b from-black/70 to-transparent z-20">
            <Link
              href={backHref}
              className="shrink-0 h-11 px-3 rounded-lg bg-black/30 text-white/90 text-sm flex items-center"
              onClick={(e) => {
                e.preventDefault();
                void exitFullscreen().then(() => router.replace(backHref));
              }}
            >
              ← 返回
            </Link>
            <span className="flex-1 min-w-0 truncate text-white/90 text-sm font-medium">{title}</span>
            <RowMenu size="lg" width={210} title="更多操作" items={phoneMenu} />
            {fsSupported && (
              <button
                onClick={toggleFullscreen}
                className="shrink-0 h-11 px-3 rounded-lg bg-blue-600 text-white text-sm transition active:bg-blue-500"
              >
                ⛶ 全屏
              </button>
            )}
          </div>

          {notice && (
            <NoticeBar
              notice={notice}
              onClose={() => setNotice(null)}
              className="absolute top-[72px] left-3 right-3 z-30"
            />
          )}
        </>
      )}

      {/* 顶部栏：全屏时彻底不渲染，翻页只靠键盘/翻页笔/点击左右半区 */}
      {!isFullscreen && !compact && (
        <div className="absolute top-0 left-0 right-0 p-4 flex items-center justify-between bg-gradient-to-b from-black/70 to-transparent z-20">
          <div className="flex items-center gap-4 min-w-0">
            <Link
              href={backHref}
              className="text-white/70 hover:text-white text-sm bg-black/30 px-3 py-1.5 rounded-lg shrink-0"
              onClick={(e) => {
                e.preventDefault();
                void exitFullscreen().then(() => router.replace(backHref));
              }}
            >
              ← 返回
            </Link>
            <span className="text-white/90 font-medium truncate max-w-[60vw]">{title}</span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {!readOnly && (
              <Link
                href={`/editor/${presentationId}`}
                className="text-white/70 hover:text-white text-sm bg-black/30 px-3 py-1.5 rounded-lg"
              >
                ✏️ 编辑
              </Link>
            )}
            <button
              onClick={() => {
                requestRemote();
                alert(
                  '🎮 遥控器说明：\n\n' +
                    '• 蓝牙/电视遥控器：已自动支持，直接按频道±翻页\n\n' +
                    '• Chrome 投屏遥控器：需浏览器支持 Presentation API\n\n' +
                    '• 键盘：Space/→ 下一页 · ←/PgUp 上一页 · Home/End 跳首末 · F 全屏'
                );
              }}
              className="text-white hover:text-white text-sm bg-green-600/80 hover:bg-green-600 px-3 py-1.5 rounded-lg transition"
              title="📱 手机/蓝牙遥控器"
            >
              📱 遥控器
            </button>
            <button
              onClick={toggleFullscreen}
              className="text-white hover:text-white text-sm bg-blue-600/80 hover:bg-blue-600 px-4 py-1.5 rounded-lg transition"
            >
              ⛶ 全屏放映
            </button>
          </div>
        </div>
      )}

      {/* 手机端底部栏：圆点条在 29 页的歌稿上是 29×8 + 28×4 = 344px，两头被切、8px 的点也按不到，
          换成首/末/上/下四个大键 + 一个能点开数字跳页的页码 */}
      {!isFullscreen && compact && (
        <>
          {jumpOpen && <div className="absolute inset-0 z-10" onClick={() => setJumpOpen(false)} />}

          <div className="absolute bottom-0 left-0 right-0 p-3 flex items-center justify-center gap-2 bg-gradient-to-t from-black/70 to-transparent z-20">
            <button
              onClick={goHome}
              className="h-11 min-w-11 rounded-lg bg-white/10 text-white/80 text-lg transition active:bg-white/25"
              title="第一页"
            >
              ⏮
            </button>
            <button
              onClick={goPrev}
              disabled={current === 0}
              className="h-11 min-w-11 rounded-lg bg-white/10 text-white text-lg transition active:bg-white/25 disabled:opacity-30"
              title="上一页"
            >
              ◀
            </button>

            <button
              onClick={() => setJumpOpen((v) => !v)}
              aria-expanded={jumpOpen}
              className="h-11 px-4 rounded-lg bg-black/40 text-white/90 text-sm tabular-nums shrink-0"
              title="跳到第几页"
            >
              {current + 1} / {total}
            </button>

            <button
              onClick={goNext}
              disabled={current === total - 1}
              className="h-11 min-w-11 rounded-lg bg-white/10 text-white text-lg transition active:bg-white/25 disabled:opacity-30"
              title="下一页"
            >
              ▶
            </button>
            <button
              onClick={goEnd}
              className="h-11 min-w-11 rounded-lg bg-white/10 text-white/80 text-lg transition active:bg-white/25"
              title="最后一页"
            >
              ⏭
            </button>
          </div>

          {jumpOpen && (
            <div className="absolute bottom-[76px] left-3 right-3 z-30 max-h-[45dvh] overflow-y-auto overscroll-contain rounded-xl border border-white/15 bg-[#14141c] p-2 grid grid-cols-6 gap-1.5">
              {slides.map((s, i) => (
                <button
                  key={s.id}
                  onClick={() => {
                    setCurrent(i);
                    setJumpOpen(false);
                  }}
                  className={`h-11 rounded-lg text-sm tabular-nums transition ${
                    i === current ? 'bg-blue-600 text-white' : 'bg-white/10 text-gray-200 active:bg-white/25'
                  }`}
                >
                  {i + 1}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {/* 底部控制栏 */}
      {!isFullscreen && !compact && (
        <div className="absolute bottom-0 left-0 right-0 p-4 flex items-center justify-center gap-2 bg-gradient-to-t from-black/70 to-transparent z-20">
          <button
            onClick={goHome}
            className="text-white/80 hover:text-white px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 transition text-sm"
            title="第一页 (Home)"
          >
            ⏮
          </button>
          <button
            onClick={goPrev}
            disabled={current === 0}
            className="text-white hover:text-white px-4 py-1.5 rounded bg-white/10 hover:bg-white/20 transition disabled:opacity-30 disabled:cursor-not-allowed"
            title="上一页 (←)"
          >
            ◀
          </button>

          <div className="flex items-center gap-1 px-2">
            {slides.map((s, i) => (
              <button
                key={s.id}
                onClick={() => setCurrent(i)}
                className={`w-2 h-2 rounded-full transition ${
                  i === current ? 'bg-white w-6' : 'bg-white/40 hover:bg-white/70'
                }`}
                title={`第 ${i + 1} 页`}
              />
            ))}
          </div>

          <button
            onClick={goNext}
            disabled={current === total - 1}
            className="text-white hover:text-white px-4 py-1.5 rounded bg-white/10 hover:bg-white/20 transition disabled:opacity-30 disabled:cursor-not-allowed"
            title="下一页 (→ / Space)"
          >
            ▶
          </button>
          <button
            onClick={goEnd}
            className="text-white/80 hover:text-white px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 transition text-sm"
            title="最后一页 (End)"
          >
            ⏭
          </button>

          <div className="text-white/70 text-sm ml-2 bg-black/40 px-3 py-1 rounded">
            {current + 1} / {total}
          </div>
        </div>
      )}

      {/* 全屏唯一的浮层：只提示一次，自动淡出，不拦点击 */}
      {isFullscreen && (
        <div
          className={`absolute bottom-8 left-1/2 -translate-x-1/2 z-30 pointer-events-none rounded-full bg-black/50 px-4 py-2 text-xs text-white/75 whitespace-nowrap transition-opacity duration-700 ${
            hintVisible ? 'opacity-100' : 'opacity-0'
          }`}
        >
          ← → / 空格 翻页 · 点击左右半区翻页 · Home/End 首末 · F 全屏 · ESC 退出全屏
        </div>
      )}

      {!isFullscreen && !compact && (
        <div className="absolute bottom-16 left-1/2 -translate-x-1/2 text-white/40 text-xs text-center pointer-events-none">
          键盘: ← → 翻页 · Home/End 跳首末 · F 全屏 · ESC 退出全屏 · 全屏后点击左右半区翻页
        </div>
      )}

      {/* 手机端不摆这个居中大键：顶栏已经有明摆着的 ⛶，而它糊在舞台正中会吃掉那一片的翻页点击 */}
      {!isFullscreen && !compact && current === 0 && fsSupported && (
        <button
          onClick={enterFullscreen}
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-20 h-20 rounded-full bg-blue-600/80 hover:bg-blue-600 flex items-center justify-center text-3xl shadow-2xl transition hover:scale-110 z-10"
        >
          ▶
        </button>
      )}

      {remoteSheet && (
        <SheetOverlay title="📱 遥控器" hint="蓝牙 / 投屏 / 键盘" onClose={() => setRemoteSheet(false)}>
          {REMOTE_HELP.map(([term, desc]) => (
            <div key={term} className="rounded-lg bg-white/5 px-3 py-2">
              <div className="text-[13px] text-gray-200">{term}</div>
              <div className="text-xs text-gray-400 mt-0.5 leading-snug">{desc}</div>
            </div>
          ))}
        </SheetOverlay>
      )}
    </div>
  );
}
