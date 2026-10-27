'use client';

/**
 * 放映时提前把后面几页要用的**网络图片**递进浏览器缓存。
 *
 * 只管图片，另外两支不归这里：
 * - `local:` 素材在本机 IndexedDB 里，不走网络。预热它要读整条 blob 再解码，还和正在
 *   屏幕上那页抢同一条连接 —— 那一页才是用户此刻唯一在乎的。
 * - 视频归 video-warm.ts：那里按片源身份决定热哪条、并在整个会话里留住头部字节，
 *   用 `<img>` 去拉一支视频只会得到一个解不开的图片，还占掉一个池位。
 *
 * 每个 URL 一次会话只热一回：来回翻页不会把它变成重复请求。真要失败也不重记，
 * 翻到那一页时渲染路径自会再发一次，这里不该替它吞掉重试。
 */
import type { Slide } from '@/types/ppt';
import { cloudPublicUrl, parseRemoteUrl } from './media-source.ts';
import { storedVideoExt } from './media-ext.ts';

const warmed = new Set<string>();

/** 只喂绝对 https 或站内绝对路径：deck 里的值经过渲染校验，这里同一把尺子，拼不出半截 URL */
function warmImage(raw: string): void {
  const url = parseRemoteUrl(raw);
  if (!url || warmed.has(url)) return;
  warmed.add(url);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
}

export function preloadSlideMedia(slide: Slide): void {
  const bg = slide.background;
  // 背景只有图片 / 云端图片两支归这里；cloud 的桶内路径要先拼出公开读域名，视频那支交给预热池
  if (bg.type === 'image') warmImage(bg.value);
  if (bg.type === 'cloud' && !storedVideoExt(bg.value)) warmImage(cloudPublicUrl(bg.value));
  for (const block of slide.imageBlocks) {
    if (block.src.kind === 'remote') warmImage(block.src.value);
    if (block.src.kind === 'cloud') warmImage(cloudPublicUrl(block.src.value));
  }
}
