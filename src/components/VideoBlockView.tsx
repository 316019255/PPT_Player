'use client';

import type { CSSProperties } from 'react';
import type { ImageFit, VideoBlock } from '@/types/ppt';
import { videoBlockStyle } from '@/components/blockStyle';
import { useResolvedSrc } from '@/components/ImageBlockView';

const OBJECT_FIT: Record<ImageFit, CSSProperties['objectFit']> = {
  fill: 'fill',
  contain: 'contain',
  cover: 'cover',
};

/**
 * 视频本体：铺满外层百分比框。autoPlay 由 animate 控制 ——
 * 缩略图条里几十路同时解码会把 GPU 打满，放映页才放开。
 */
export function VideoFrame({
  url,
  fit,
  alt,
  animate,
  loop,
  muted,
  controls,
}: {
  url: string;
  fit?: ImageFit;
  alt?: string;
  animate: boolean;
  loop: boolean;
  muted: boolean;
  controls: boolean;
}) {
  return (
    <video
      src={url}
      aria-label={alt ?? ''}
      className="w-full h-full"
      style={{ objectFit: OBJECT_FIT[fit ?? 'contain'] }}
      autoPlay={animate}
      muted={muted}
      loop={loop}
      playsInline
      preload={animate ? 'auto' : 'metadata'}
      controls={controls}
      // 编辑器里禁止指针事件，避免和拖拽层打架；放映页无影响
      controlsList="nodownload"
    />
  );
}

/** 只读渲染（放映 + 缩略图条）：animate 由外层决定要不要自动播放 */
export function VideoBlockView({
  block,
  lowres = false,
  animate = true,
}: {
  block: VideoBlock;
  lowres?: boolean;
  animate?: boolean;
}) {
  const resolved = useResolvedSrc(block.src, lowres, 'video');
  return (
    <div style={videoBlockStyle(block)}>
      {resolved.status === 'ready' && (
        <VideoFrame
          url={resolved.url}
          fit={block.fit}
          alt={block.alt}
          animate={animate}
          loop={block.loop ?? false}
          muted={block.muted !== false}
          controls={block.controls ?? false}
        />
      )}
    </div>
  );
}
