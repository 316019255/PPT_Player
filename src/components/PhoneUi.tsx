'use client';

import type { ReactNode } from 'react';

/**
 * 手机抽屉里反复出现的那几样：一行按键、一个键、一条带读数的滑杆、一排色板。
 * 只在这几个文件里用，尺寸（40/44px、16px 字号、2px 圆角）统一在这里定，
 * 免得每个抽屉各写一套、同一屏里手指高度不一样。
 */

/** 预设色：歌词最常用的几档，最后一格交给原生取色器 */
export const PRESET_COLORS = ['#ffffff', '#000000', '#ffd400', '#ff5b5b', '#5bd0ff', '#7ee787', '#c084fc', '#ff9f43'];

export function KeyRow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`flex gap-1.5 min-w-0 ${className}`}>{children}</div>;
}

interface KeyProps {
  onClick: () => void;
  children: ReactNode;
  active?: boolean;
  danger?: boolean;
  primary?: boolean;
  tall?: boolean;
  disabled?: boolean;
  title?: string;
}

export function PhoneKey({ onClick, children, active, danger, primary, tall, disabled, title }: KeyProps) {
  const tone = danger
    ? 'bg-red-600/20 text-red-300 active:bg-red-600/40'
    : primary
      ? 'bg-blue-600 text-white active:bg-blue-500'
      : active
        ? 'bg-blue-600 text-white'
        : 'bg-white/10 text-gray-200 active:bg-white/25';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex-1 min-w-0 rounded-lg text-[11px] leading-tight px-1.5 transition active:opacity-90 disabled:opacity-30 ${
        tall ? 'h-11' : 'h-10'
      } ${tone}`}
    >
      {children}
    </button>
  );
}

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  readout: string;
  onChange: (value: number) => void;
}

/** 读数写在标签同一行：滑杆挡住字的话，手机上就永远看不到当前值 */
export function LabeledSlider({ label, value, min, max, step, readout, onChange }: SliderProps) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between text-[11px] leading-4">
        <span className="text-gray-400">{label}</span>
        <span className="tabular-nums text-gray-300">{readout}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-blue-500"
      />
    </label>
  );
}

/** 预设色点 + 原生取色器：点一下就换，要精确色值再展开系统的色板 */
export function SwatchRow({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {PRESET_COLORS.map((hex) => (
        <button
          key={hex}
          onClick={() => onChange(hex)}
          title={hex}
          className={`w-8 h-8 shrink-0 rounded-lg border ${
            value.toLowerCase() === hex ? 'border-blue-500 ring-1 ring-blue-500/60' : 'border-white/20'
          }`}
          style={{ background: hex }}
        />
      ))}
      <input
        type="color"
        value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#ffffff'}
        onChange={(e) => onChange(e.target.value)}
        title="自选颜色"
        className="w-10 h-8 shrink-0 ml-auto rounded-lg bg-transparent border border-white/20"
      />
    </div>
  );
}

/**
 * 页内多块时的选择器：歌词页常常有十几行文字，手指在 0.29 缩放的画布上点不准，
 * 所以「编辑哪一块」在抽屉里也有一条明摆着的路。
 * wrap=true 时装不下就折到下面（图片那种几块一页的窗口不留横向拉杆）；
 * 文字那种十几行的还是横条，折行会占掉三四排、把输入框挤出屏幕。
 */
export function ChipRow({
  chips, activeId, onPick, onAdd, addText, wrap = false,
}: {
  chips: { id: string; label: string }[];
  activeId: string | null;
  onPick: (id: string) => void;
  /** 尾部那颗新增键是可选的：图片窗的开关放在标题栏那一行，这里就不重复给 */
  onAdd?: () => void;
  addText?: string;
  wrap?: boolean;
}) {
  return (
    <div className={`flex items-center gap-1.5 ${wrap ? 'flex-wrap' : 'bg-strip-scroll overflow-x-auto overflow-y-hidden -mx-0.5 px-0.5'}`}>
      {chips.map((chip, i) => (
        <button
          key={chip.id}
          onClick={() => onPick(chip.id)}
          className={`shrink-0 h-9 px-3 rounded-lg text-[11px] max-w-[9rem] truncate transition ${
            chip.id === activeId ? 'bg-blue-600 text-white' : 'bg-white/10 text-gray-300 active:bg-white/25'
          }`}
        >
          {i + 1}·{chip.label}
        </button>
      ))}
      {addText && (
        <button
          onClick={onAdd}
          className="shrink-0 h-9 px-3 rounded-lg text-[11px] bg-white/15 text-white active:bg-white/25"
        >
          {addText}
        </button>
      )}
    </div>
  );
}

export function SheetHint({ children }: { children: ReactNode }) {
  return <p className="text-[11px] leading-snug text-gray-500">{children}</p>;
}
