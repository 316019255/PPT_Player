'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

/** 手机工具坞的五个抽屉，永远只开一个 */
export type PhoneGroupId = 'text' | 'image' | 'video' | 'background' | 'pages';

const KEYS: { id: PhoneGroupId; icon: string; label: string }[] = [
  { id: 'pages', icon: '📄', label: '页面' },
  { id: 'text', icon: '✏️', label: '文字' },
  { id: 'image', icon: '🖼️', label: '图片' },
  { id: 'video', icon: '🎬', label: '视频' },
  { id: 'background', icon: '🎨', label: '背景' },
];

interface DockProps {
  open: PhoneGroupId | null;
  /** 每个键下面那行小字：这一页有几块、第几页、现在是什么背景 */
  counts: Record<PhoneGroupId, string>;
  onToggle: (group: PhoneGroupId) => void;
}

/**
 * 常驻工具坞：四个键一直在，一眼能看见能按到，不做「选中了才冒出来」那种隐藏入口。
 * 键上那行小字（块数/页码/背景类型）就是当前页的状态读数。
 */
export function PhoneDock({ open, counts, onToggle }: DockProps) {
  return (
    <div className="h-full flex gap-1.5">
      {KEYS.map(({ id, icon, label }) => {
        const active = open === id;
        return (
          <button
            key={id}
            onClick={() => onToggle(id)}
            aria-pressed={active}
            className={`flex-1 min-w-0 h-full rounded-lg border flex flex-col items-center justify-center transition ${
              active
                ? 'border-blue-500 bg-blue-600/25 text-white'
                : 'border-white/10 bg-white/5 text-gray-400 active:bg-white/15'
            }`}
          >
            <span className="text-[15px] leading-none">{icon}</span>
            <span className="mt-0.5 text-[11px] leading-none">{label}</span>
            <span className={`mt-0.5 text-[10px] leading-none truncate max-w-full ${
              active ? 'text-blue-200' : 'text-gray-500'
            }`}>{counts[id]}</span>
          </button>
        );
      })}
    </div>
  );
}

interface SheetProps {
  title: string;
  /** 提示语可以带一个就地按钮（比如图片窗的「＋ 插一张 / ✕ 收起选图」） */
  hint?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}

/**
 * 抽屉外壳：标题 + 一个明摆着的关闭键 + 内部滚动。
 * 高度由外层给死（画布下面剩下的那一块），所以窗里的控件超出一屏才滚动，切换抽屉不会把画布顶得跳一下。
 */
export function SheetShell({ title, hint, onClose, children }: SheetProps) {
  return (
    <div className="h-full flex flex-col rounded-xl border border-white/15 bg-[#14141c] shadow-[0_-10px_30px_rgba(0,0,0,0.55)] overflow-hidden">
      <div className="h-9 shrink-0 flex items-center gap-2 px-2.5 border-b border-white/10 bg-white/5">
        <span className="text-xs font-medium text-gray-200 shrink-0">{title}</span>
        {hint && (
          <div className="flex items-center gap-1.5 min-w-0 text-[10px] text-gray-500">{hint}</div>
        )}
        <button
          onClick={onClose}
          title="收起面板"
          className="ml-auto w-7 h-7 shrink-0 -mr-1 rounded-lg bg-white/10 text-gray-300 active:bg-white/25"
        >
          ✕
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-2 space-y-1.5 flex flex-col [&>*]:shrink-0">{children}</div>
    </div>
  );
}

/** 确认态活 4 秒：够看清自己按的是哪一个，又不会放着不管一直悬在那儿 */
const ARMED_MS = 4000;

/**
 * 删除类操作统一走「按一次 → 再确认一次」，不用系统 confirm：
 * 系统的框在部分安卓浏览器上会被静默记住，点了「不再提示」就等于没有确认。
 */
export function ConfirmKey({
  label, confirmLabel, danger = true, onConfirm,
}: {
  label: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!armed) return;
    // 手机上点按钮通常不会让它拿到焦点，onBlur 在 iOS 上基本不触发，
    // 所以确认态必须自己会过期：按到别处、或者放着不点，都会自动取消。
    const onOutside = (e: PointerEvent) => {
      if (!btn.current?.contains(e.target as Node)) setArmed(false);
    };
    const timer = setTimeout(() => setArmed(false), ARMED_MS);
    document.addEventListener('pointerdown', onOutside, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerdown', onOutside, true);
    };
  }, [armed]);

  return (
    <button
      ref={btn}
      onClick={() => {
        if (!armed) { setArmed(true); return; }
        setArmed(false);
        onConfirm();
      }}
      onBlur={() => setArmed(false)}
      className={`flex-1 min-w-0 h-11 rounded-lg text-[11px] leading-tight px-1.5 transition ${
        danger
          ? armed ? 'bg-red-600 text-white' : 'bg-red-600/20 text-red-300 active:bg-red-600/40'
          : armed ? 'bg-blue-600 text-white' : 'bg-white/10 text-gray-200 active:bg-white/25'
      }`}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}
