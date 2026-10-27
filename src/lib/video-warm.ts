'use client';

/**
 * 背景视频预热池：翻页之前先把下一条片源的**头部字节**攥住，并且整个会话都攥着。
 *
 * 为什么要「攥住不放」：`<video>` 一被销毁，浏览器就没理由再替这个 URL 保留已经拉下来的
 * 那段头部；等用户真翻到那一页，新元素得从重新探测 moov 开始再跑一遍 —— 屏幕上就是那一下黑。
 * 池里的元素从不 play，也不进布局，它唯一的作用是让那些字节一直有个主人。
 *
 * 为什么只热头部：素材是几十到一百多兆的 MP4，`preload="auto"` 会一路缓冲到目标时长，
 * 换来的多半是用户根本不翻过去的流量。`metadata` + seek 一次，只拿解码首帧要的那点。
 *
 * 不变量：一个 URL 要么在屏幕上（被某一层 hold 住），要么在池里，不会同时两处 ——
 * 否则同一支视频的头部会被拉两遍。
 */
import { parseRemoteUrl } from './media-source.ts';

/** 池里最多留几条不在屏幕上的片源：再多就是在替用户下载他可能翻不到的视频 */
const MAX_WARM = 3;

/** seek 到这个秒数：逼浏览器把解码首帧要的那段（约一个 GOP）真的取回来，而不只是读个元信息 */
const HEAD_SECONDS = 0.1;

interface WarmEntry {
  el: HTMLVideoElement;
  /** 用的不是时钟：同一毫秒里连续热两条会打成平手，淘汰就变成看谁先被写进 Map */
  usedAt: number;
}

/** url → 池里的元素 */
const pooled = new Map<string, WarmEntry>();
/** url → 屏幕上持有它的层数 */
const held = new Map<string, number>();
let clock = 0;
let host: HTMLDivElement | null = null;

/**
 * 池的容器：1×1、透明、pointer-events none，但**不能** display:none。
 * 隐藏得太彻底的媒体元素，浏览器会当成不重要而推迟甚至停止预加载。
 */
function warmHost(): HTMLDivElement {
  if (!host) {
    const el = document.createElement('div');
    el.id = 'ppt-video-warm';
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden';
    document.body.appendChild(el);
    host = el;
  }
  return host;
}

function destroy(url: string): void {
  const entry = pooled.get(url);
  if (!entry) return;
  pooled.delete(url);
  // 先摘 src 再 load()：只 remove 元素的话，进行中的 range 请求不会立刻停
  entry.el.removeAttribute('src');
  entry.el.load();
  entry.el.remove();
}

/** 超出上限就丢掉最久没被用到的那条 */
function evict(): void {
  if (pooled.size <= MAX_WARM) return;
  let oldestUrl = '';
  let oldest = Infinity;
  for (const [url, entry] of pooled) {
    if (entry.usedAt < oldest) {
      oldest = entry.usedAt;
      oldestUrl = url;
    }
  }
  if (oldestUrl) destroy(oldestUrl);
}

/**
 * 把一条**现在不在屏幕上**的片源提前拉好，留在会话里。
 * blob:（本机素材，本来就在硬盘上）和非法地址都会被 parseRemoteUrl 归零，直接不管。
 */
export function warmVideo(rawUrl: string): void {
  if (typeof document === 'undefined') return;
  const url = parseRemoteUrl(rawUrl);
  if (!url || held.has(url)) return;
  const hit = pooled.get(url);
  if (hit) {
    hit.usedAt = ++clock;
    return;
  }
  const el = document.createElement('video');
  el.muted = true;
  el.playsInline = true;
  el.preload = 'metadata';
  // 探针按这个属性数池子；也方便在 devtools 里认出是谁在下载
  el.dataset.warmUrl = url;
  el.addEventListener('loadedmetadata', () => {
    // seek 才算真的去取首帧那段字节；不 seek 的话 metadata 只够知道时长
    if (el.readyState >= 1) el.currentTime = HEAD_SECONDS;
  });
  // 取不到就别占着池位：留着一条永远报错的元素，等于每次都白试一遍
  el.addEventListener('error', () => destroy(url));
  warmHost().appendChild(el);
  pooled.set(url, { el, usedAt: ++clock });
  el.src = url;
  evict();
}

/**
 * 屏幕上有层在放这条了：池让位（同一 URL 不拉两遍），并返回「这一层不再放它」时要做的事 ——
 * 交还引用计数，然后把它的字节转交给池。effect 直接 `return holdVideo(url)` 就是完整的配对。
 */
export function holdVideo(rawUrl: string): () => void {
  const url = parseRemoteUrl(rawUrl);
  if (!url) return () => {};
  destroy(url);
  held.set(url, (held.get(url) ?? 0) + 1);
  let claimed = false;
  return () => {
    // 双调用（StrictMode 之外不该有）也只减一次：减成负数会把别人的引用吞掉
    if (claimed) return;
    claimed = true;
    const left = (held.get(url) ?? 1) - 1;
    if (left > 0) held.set(url, left);
    else held.delete(url);
    warmVideo(url);
  };
}
