'use client';

import type { ImageSource } from '@/types/ppt';
import { MediaPicker } from '@/components/MediaPicker';

/** 向后兼容包装：Phase 6 的编辑器集成会直接用 MediaPicker */
export function ImagePicker({ onInsert }: { onInsert: (src: ImageSource, alt?: string) => void }) {
  return <MediaPicker kind="image" onInsert={onInsert} />;
}
