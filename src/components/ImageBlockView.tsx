'use client';

/* eslint-disable @next/next/no-img-element -- 图片可能是 blob: URL、任意外链或公开桶对象，next/image 要固定的 remotePatterns/loader，这里直接用 img */
import type { CSSProperties } from 'react';
import type { ImageBlock, ImageFit, MediaSource } from '@/types/ppt';
import type { MediaKind } from '@/lib/media-ext';
import { imageBlockStyle } from '@/components/blockStyle';
import { cloudPublicUrl } from '@/lib/media-source';
import { parseLocalKey } from '@/lib/slide-data';
import { useLocalMaterial, useLocalThumb } from '@/lib/localMaterials';

/**
 * 来源的解析结果。缺素材/读失败由调用方决定怎么降级：
 * 放映只降级不提示，编辑器才显示角标。
 */
export type ResolvedSrc =
  | { status: 'pending' }
  | { status: 'ready'; url: string }
  | { status: 'blank' }
  | { status: 'missing' }
  | { status: 'error'; reason: string };

/**
 * 三种来源收敛成一个能渲染的 URL。expect 决定「本地库里拿到的是图片还是视频」
 * 是否匹配：图片块塞了视频文件 → missing，视频块塞了图片文件 → 也 missing。
 *
 * local 走 IndexedDB，而且按 lowres 分两条路：缩略图条只读那张 ~10KB 的预览图，
 * 50 个格子各解一张原图会把内存吃光（背景条同一套规矩）。
 * 两个本地 hook 都必须无条件调用，不是自己那一支就传 ''，
 * hook 自带守卫（'' 直接 missing，一次 IndexedDB 都不碰）。
 */
export function useResolvedSrc(src: MediaSource, lowres: boolean, expect: MediaKind): ResolvedSrc {
  const key = src.kind === 'local' ? parseLocalKey(src.value) : '';
  const thumb = useLocalThumb(lowres ? key : '');
  // blank = 素材在库里但没预览槽（预览功能之前导入的老素材）。
  // 这一支退回原图，否则缩略图条会把它画成空格子；除此之外缩略图条不碰原图。
  const fallbackToFull = thumb.status === 'blank';
  const full = useLocalMaterial(!lowres || fallbackToFull ? key : '');

  if (src.kind === 'remote') return { status: 'ready', url: src.value };
  if (src.kind === 'cloud') {
    // 没配 NEXT_PUBLIC_MEDIA_PUBLIC_BASE 就当作缺素材：宁可降级，也不拼半截 URL 去请求
    const url = cloudPublicUrl(src.value);
    return url ? { status: 'ready', url } : { status: 'missing' };
  }
  if (!key) return { status: 'missing' };

  const local = lowres && !fallbackToFull ? thumb : full;
  if (local.status !== 'ready') return local;
  // 本地库里图片和视频混放，块期望的 kind 和实际不一致 → 按缺素材处理
  if ('kind' in local && local.kind !== expect) return { status: 'missing' };
  return { status: 'ready', url: local.url };
}

const OBJECT_FIT: Record<ImageFit, CSSProperties['objectFit']> = {
  fill: 'fill',
  contain: 'contain',
  cover: 'cover',
};

/** 图片本体：铺满外层那个百分比框，裁切由外层的 overflow:hidden 负责 */
export function ImageFrame({ url, fit, alt }: { url: string; fit?: ImageFit; alt?: string }) {
  return (
    <img
      src={url}
      alt={alt ?? ''}
      className="w-full h-full"
      style={{ objectFit: OBJECT_FIT[fit ?? 'contain'] }}
      // 缩略图条里有几十个格子，懒挂载能免掉看不见的图；放映页本来就一页一张
      loading="lazy"
      decoding="async"
      draggable={false}
    />
  );
}

/**
 * 只读渲染（放映 + 左侧缩略图条）。
 * 外层不挂 `.player-block`，那个类把 z-index 写死成 2，会让图片永远压在文字下面。
 */
export function ImageBlockView({ block, lowres = false }: { block: ImageBlock; lowres?: boolean }) {
  const resolved = useResolvedSrc(block.src, lowres, 'image');
  return <div style={imageBlockStyle(block)}>{resolved.status === 'ready' && <ImageFrame url={resolved.url} fit={block.fit} alt={block.alt} />}</div>;
}
