'use client';

import { useEffect } from 'react';
import type { ImageBlock, MediaSource, Slide, TextBlock, VideoBlock } from '@/types/ppt';
import {
  DEFAULT_BLOCK_HEIGHT,
  MIN_HEIGHT,
  MIN_WIDTH,
  STAGE_MAX,
  clamp,
  clampSize,
  type GeometryPatch,
} from '@/lib/block-geometry';
import { parseLocalKey } from '@/lib/slide-data';
import { hasMediaBase } from '@/lib/media-source';
import { CloudifyButton } from '@/components/CloudifyButton';
import { MediaPicker } from '@/components/MediaPicker';
import { ConfirmKey } from '@/components/PhoneDock';
import { ChipRow, KeyRow, LabeledSlider, PhoneKey, SheetHint, SwatchRow } from '@/components/PhoneUi';

const FONT_MIN = 10;
const FONT_MAX = 144;
/** 不给到 0：整行看不见会让人以为字丢了，10% 至少还有一层影子 */
const ALPHA_MIN = 10;

interface Common {
  slide: Slide;
  activeId: string | null;
  onPick: (id: string | null) => void;
  onAdd: () => void;
  onDelete: (id: string) => void;
}

/**
 * 选中态兜底：抽屉开着但画布上没选中（新增页带来的默认文字块就是这种），
 * 就退回这一页的第一块，并把它选上 —— 画布的高亮框、屏幕层手柄、抽屉看的是同一块。
 */
function useActiveBlock<T extends { id: string }>(blocks: T[], activeId: string | null, onPick: (id: string | null) => void): T | null {
  const block = blocks.find((b) => b.id === activeId) ?? blocks[0] ?? null;
  useEffect(() => {
    if (block && block.id !== activeId) onPick(block.id);
  }, [block, activeId, onPick]);
  return block;
}

/** 行内几何改动：宽高一律过 clampSize，和拉手柄同一套边界 */
function geometryPatch(block: { x: number; y: number; width: number; height?: number }, next: Partial<{ width: number; height: number }>): GeometryPatch {
  const width = clampSize('width', next.width ?? block.width, block);
  const height = clampSize('height', next.height ?? block.height ?? DEFAULT_BLOCK_HEIGHT, block);
  return { x: block.x, y: block.y, width, height };
}

const layerKeys = (
  zIndex: number,
  maxZ: number,
  set: (z: number) => void
) => (
  <KeyRow>
    <PhoneKey onClick={() => set(1)} title="压到最底下">最后</PhoneKey>
    <PhoneKey onClick={() => set(zIndex - 1)} title="往下压一层">↓一层</PhoneKey>
    <PhoneKey onClick={() => set(zIndex + 1)} title="往上抬一层">↑一层</PhoneKey>
    <PhoneKey onClick={() => set(maxZ + 1)} active={zIndex >= maxZ} title="盖住其它东西">最前</PhoneKey>
  </KeyRow>
);

/** 一块页面上所有元素的最高层级，「最前」就是抬到它上面一档 */
function topZIndex(slide: Slide): number {
  const all = [...slide.textBlocks, ...slide.imageBlocks].map((b) => b.zIndex ?? 1);
  return all.length ? Math.max(...all) : 1;
}

// ============ 文字抽屉 ============
interface TextSheetProps extends Common {
  onChange: (id: string, updates: Partial<TextBlock>) => void;
  onDuplicate: (id: string) => void;
}

export function TextSheet({ slide, activeId, onPick, onAdd, onDelete, onChange, onDuplicate }: TextSheetProps) {
  const block = useActiveBlock(slide.textBlocks, activeId, onPick);
  if (!block) {
    return (
      <>
        <SheetHint>这一页还没有文字。点下面加一行，键盘弹出来直接打字，画布上同步变。</SheetHint>
        <PhoneKey onClick={onAdd} primary tall>＋ 加一行文字</PhoneKey>
      </>
    );
  }

  const set = (updates: Partial<TextBlock>) => onChange(block.id, updates);
  const setZ = (z: number) => set({ zIndex: clamp(Math.round(z), 1, 999) });
  const height = block.height ?? 12;
  const opacity = Math.round((block.opacity ?? 1) * 100);

  return (
    <>
      <ChipRow
        chips={slide.textBlocks.map((b) => ({ id: b.id, label: lineLabel(b.text) }))}
        activeId={block.id}
        onPick={(id) => onPick(id)}
        onAdd={onAdd}
        addText="＋ 加一行"
      />

      {/* 打字走抽屉里的输入框：舞台缩到 0.29，contentEditable 的光标和选区在手机上根本对不准 */}
      <textarea
        value={block.text}
        onChange={(e) => set({ text: e.target.value })}
        rows={2}
        spellCheck={false}
        placeholder="在这里打字，画布同步预览"
        className="w-full min-h-[52px] grow resize-y rounded-lg bg-white/5 border border-white/15 px-2.5 py-1.5 text-base leading-snug text-white outline-none focus:border-blue-500"
      />

      <KeyRow className="items-center">
        <PhoneKey onClick={() => set({ fontSize: Math.max(FONT_MIN, block.fontSize - 2) })}>A−</PhoneKey>
        <input
          type="range"
          min={FONT_MIN}
          max={FONT_MAX}
          value={clamp(block.fontSize, FONT_MIN, FONT_MAX)}
          onChange={(e) => set({ fontSize: Number(e.target.value) })}
          className="flex-1 min-w-0 accent-blue-500"
          aria-label="字号"
        />
        <PhoneKey onClick={() => set({ fontSize: Math.min(FONT_MAX, block.fontSize + 2) })}>A+</PhoneKey>
        <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-gray-300">{block.fontSize}px</span>
      </KeyRow>

      <SwatchRow value={block.color} onChange={(color) => set({ color })} />

      <KeyRow>
        {(['left', 'center', 'right'] as const).map((align) => (
          <PhoneKey key={align} onClick={() => set({ textAlign: align })} active={block.textAlign === align}>
            {align === 'left' ? '⬅ 左' : align === 'center' ? '⬌ 中' : '右 ➡'}
          </PhoneKey>
        ))}
        <PhoneKey onClick={() => set({ fontWeight: block.fontWeight === 'bold' ? 'normal' : 'bold' })}
          active={block.fontWeight === 'bold'}>粗</PhoneKey>
        <PhoneKey onClick={() => set({ fontStyle: block.fontStyle === 'italic' ? 'normal' : 'italic' })}
          active={block.fontStyle === 'italic'}>斜</PhoneKey>
      </KeyRow>

      {layerKeys(block.zIndex ?? 1, topZIndex(slide), setZ)}

      {/* 三条滑杆并排：一屏放完比读数写全更重要，位置对不对看画布比看数字准 */}
      <div className="grid grid-cols-3 gap-2 min-w-0">
        <LabeledSlider
          label="宽"
          value={block.width}
          min={MIN_WIDTH}
          max={STAGE_MAX}
          readout={`${block.width.toFixed(0)}%`}
          onChange={(v) => onChange(block.id, geometryPatch(block, { width: v }))}
        />
        <LabeledSlider
          label="高"
          value={height}
          min={MIN_HEIGHT}
          max={STAGE_MAX}
          readout={`${height.toFixed(0)}%`}
          onChange={(v) => onChange(block.id, geometryPatch(block, { height: v }))}
        />
        <LabeledSlider
          label="透明"
          value={opacity}
          min={ALPHA_MIN}
          max={100}
          readout={`${opacity}%`}
          onChange={(v) => set({ opacity: v / 100 })}
        />
      </div>

      <KeyRow>
        <PhoneKey onClick={() => onDuplicate(block.id)}>⧉ 复制这一行</PhoneKey>
        <ConfirmKey key={block.id} label="🗑 删除这一行" confirmLabel="再点一次就删" onConfirm={() => onDelete(block.id)} />
      </KeyRow>
    </>
  );
}

function lineLabel(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat ? flat.slice(0, 8) : '空行';
}

// ============ 图片抽屉 ============
interface ImageSheetProps extends Omit<Common, 'onAdd'> {
  onChange: (id: string, updates: Partial<ImageBlock>) => void;
  onInsert: (src: MediaSource, alt?: string) => void;
  /** 选图器摊开还是收起：那颗开关在抽屉标题栏的提示语后面，所以状态得由外壳拿着 */
  picking: boolean;
  onPickingChange: (open: boolean) => void;
}

const FITS: { value: NonNullable<ImageBlock['fit']>; label: string; hint: string }[] = [
  { value: 'contain', label: '完整', hint: '整张显示，框里可能留白' },
  { value: 'cover', label: '填满', hint: '铺满框，超出裁掉' },
  { value: 'fill', label: '拉伸', hint: '硬拉到框尺寸，可能变形' },
];

const KIND_TAG: Record<MediaSource['kind'], string> = { local: '本机', cloud: '云端', remote: '网络' };

export function ImageSheet({ slide, activeId, onPick, onDelete, onChange, onInsert, picking, onPickingChange }: ImageSheetProps) {
  const block = useActiveBlock(slide.imageBlocks, activeId, onPick);

  // 插完一张就收起选图器，把地方让给刚插进去的那块的属性
  const insert = (src: MediaSource, alt?: string) => {
    onInsert(src, alt);
    onPickingChange(false);
  };

  return (
    <>
      <ChipRow
        wrap
        chips={slide.imageBlocks.map((b) => ({ id: b.id, label: KIND_TAG[b.src.kind] }))}
        activeId={block?.id ?? null}
        onPick={(id) => { onPick(id); onPickingChange(false); }}
      />

      {picking && <MediaPicker kind="image" onInsert={insert} />}

      {block ? (
        <>
          <KeyRow>
            {FITS.map((fit) => (
              <PhoneKey key={fit.value} onClick={() => onChange(block.id, { fit: fit.value })}
                active={(block.fit ?? 'contain') === fit.value} title={fit.hint}>
                {fit.label}
              </PhoneKey>
            ))}
          </KeyRow>

          {layerKeys(block.zIndex ?? 1, topZIndex(slide), (z) => onChange(block.id, { zIndex: clamp(Math.round(z), 1, 999) }))}

          <div className="grid grid-cols-2 gap-2 min-w-0">
            <LabeledSlider
              label="宽"
              value={block.width}
              min={MIN_WIDTH}
              max={STAGE_MAX}
              readout={`${block.width.toFixed(0)}%`}
              onChange={(v) => onChange(block.id, geometryPatch(block, { width: v }))}
            />
            <LabeledSlider
              label="高"
              value={block.height}
              min={MIN_HEIGHT}
              max={STAGE_MAX}
              readout={`${block.height.toFixed(0)}%`}
              onChange={(v) => onChange(block.id, geometryPatch(block, { height: v }))}
            />
          </div>

          {block.src.kind === 'local' && hasMediaBase() && (
            <CloudifyButton
              localKey={parseLocalKey(block.src.value)}
              onDone={(path) => onChange(block.id, { src: { kind: 'cloud', value: path } })}
            />
          )}

          <KeyRow>
            <ConfirmKey key={block.id} label="🗑 删除这张" confirmLabel="再点一次就删" onConfirm={() => onDelete(block.id)} />
          </KeyRow>
        </>
      ) : (
        !picking && <SheetHint>这一页还没有图片。点上面「＋插一张」，本机 / 云端 / 网络地址都能选。</SheetHint>
      )}
    </>
  );
}

// ============ 视频抽屉 ============
interface VideoSheetProps extends Omit<Common, 'onAdd'> {
  onChange: (id: string, updates: Partial<VideoBlock>) => void;
  onInsert: (src: MediaSource, alt?: string) => void;
}

export function VideoSheet({ slide, activeId, onPick, onDelete, onChange, onInsert }: VideoSheetProps) {
  const block = useActiveBlock(slide.videoBlocks, activeId, onPick);

  return (
    <>
      <ChipRow
        wrap
        chips={slide.videoBlocks.map((b) => ({ id: b.id, label: KIND_TAG[b.src.kind] }))}
        activeId={block?.id ?? null}
        onPick={onPick}
      />

      {!block && (
        <div className="shrink-0">
          <MediaPicker kind="video" onInsert={onInsert} />
        </div>
      )}

      {block ? (
        <>
          <KeyRow>
            {FITS.map((fit) => (
              <PhoneKey key={fit.value} onClick={() => onChange(block.id, { fit: fit.value })}
                active={(block.fit ?? 'contain') === fit.value} title={fit.hint}>
                {fit.label}
              </PhoneKey>
            ))}
          </KeyRow>

          <KeyRow>
            <PhoneKey onClick={() => onChange(block.id, { loop: !(block.loop ?? false) })}
              active={block.loop ?? false} title="循环播放">
              🔁 循环
            </PhoneKey>
            <PhoneKey onClick={() => onChange(block.id, { muted: block.muted === false })}
              active={block.muted !== false} title="静音播放">
              🔇 静音
            </PhoneKey>
            <PhoneKey onClick={() => onChange(block.id, { controls: !(block.controls ?? false) })}
              active={block.controls ?? false} title="显示播放控件">
              🎛️ 控件
            </PhoneKey>
          </KeyRow>

          {layerKeys(block.zIndex ?? 1, topZIndex(slide), (z) => onChange(block.id, { zIndex: clamp(Math.round(z), 1, 999) }))}

          <div className="grid grid-cols-2 gap-2 min-w-0">
            <LabeledSlider
              label="宽"
              value={block.width}
              min={MIN_WIDTH}
              max={STAGE_MAX}
              readout={`${block.width.toFixed(0)}%`}
              onChange={(v) => onChange(block.id, geometryPatch(block, { width: v }))}
            />
            <LabeledSlider
              label="高"
              value={block.height}
              min={MIN_HEIGHT}
              max={STAGE_MAX}
              readout={`${block.height.toFixed(0)}%`}
              onChange={(v) => onChange(block.id, geometryPatch(block, { height: v }))}
            />
          </div>

          {block.src.kind === 'local' && hasMediaBase() && (
            <CloudifyButton
              localKey={parseLocalKey(block.src.value)}
              onDone={(path) => onChange(block.id, { src: { kind: 'cloud', value: path } })}
            />
          )}

          <KeyRow>
            <ConfirmKey key={block.id} label="🗑 删除这个" confirmLabel="再点一次就删" onConfirm={() => onDelete(block.id)} />
          </KeyRow>
        </>
      ) : (
        !block && slide.videoBlocks.length === 0 && (
          <SheetHint>这一页还没有视频。用上面的选择器插一个，本机 / 云端 / 网络地址都能选。</SheetHint>
        )
      )}
    </>
  );
}

// ============ 页面抽屉 ============
interface PagesSheetProps {
  slides: Slide[];
  currentIndex: number;
  onPick: (index: number) => void;
  onAdd: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
  /** 缩略图本身：画布只有一棵树，这里复用只读渲染 */
  renderThumb: (slide: Slide) => React.ReactNode;
  addDisabled?: boolean;
  duplicateDisabled?: boolean;
}

export function PagesSheet({ slides, currentIndex, onPick, onAdd, onDuplicate, onRemove, renderThumb, addDisabled, duplicateDisabled }: PagesSheetProps) {
  return (
    <>
      <KeyRow>
        <PhoneKey onClick={onAdd} primary tall disabled={addDisabled}>＋ 新增一页</PhoneKey>
        <PhoneKey onClick={onDuplicate} tall disabled={duplicateDisabled}>⧉ 复制本页</PhoneKey>
        <ConfirmKey
          key={currentIndex}
          label="🗑 删除本页"
          confirmLabel={`确认删第 ${currentIndex + 1} 页`}
          danger
          onConfirm={onRemove}
        />
      </KeyRow>

      <SheetHint>
        共 {slides.length} 页，点缩略图切过去。当前第 {currentIndex + 1} 页（蓝框那一张）。
      </SheetHint>

      {/* 两列网格 + 吃掉剩余高度：横排一次只看得见两页，歌词本子常常几十页 */}
      <div className="bg-strip-scroll grid grid-cols-2 gap-2 grow shrink-0 min-h-[92px] content-start overflow-y-auto">
        {slides.map((slide, i) => (
          <button
            key={slide.id}
            onClick={() => onPick(i)}
            className={`relative aspect-video w-full rounded-lg overflow-hidden border-2 text-left ${
              i === currentIndex ? 'border-blue-500' : 'border-white/10'
            }`}
          >
            {renderThumb(slide)}
            <span className="absolute bottom-0.5 left-0.5 text-[10px] bg-black/60 px-1 rounded">{i + 1}</span>
          </button>
        ))}
      </div>
    </>
  );
}
