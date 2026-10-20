'use client';

import { useEffect, useRef, useState } from 'react';

export type RowMenuItem =
  | { kind: 'label'; label: string }
  | { kind: 'divider' }
  | {
      kind: 'action';
      label: string;
      onClick: () => void;
      tone?: 'default' | 'danger';
      disabled?: boolean;
      checked?: boolean;
    };

interface Props {
  items: RowMenuItem[];
  width?: number;
  title?: string;
  /** 手机端要 44px 的触发键；默认 'sm' 保持桌面那套 28px 不变 */
  size?: 'sm' | 'lg';
}

const MENU_MAX_HEIGHT = 320;
const GAP = 4;
const EDGE = 8;

/** 整组替换尺寸 token：同一个 class 串里留两个宽度（w-7 和 w-11）等于赌 CSS 发射顺序 */
const TRIGGER_SIZE = {
  sm: 'w-7 h-7',
  lg: 'w-11 h-11 text-lg',
} as const;

/** 菜单行也得跟着走：lg 档只放大触发键、行高留在 33px 的话，手机端打开菜单还是按不准 */
const ROW_SIZE = {
  sm: 'py-1.5 text-sm',
  lg: 'h-11 text-[15px]',
} as const;

/**
 * 常驻的 ⋯ 操作菜单。用 fixed 定位是为了逃出侧栏/主区的 overflow 容器，
 * 否则菜单会被裁剪出一截滚动条。
 */
export default function RowMenu({ items, width = 180, title = '更多操作', size = 'sm' }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const trigger = triggerRef.current?.getBoundingClientRect();
    const menu = menuRef.current;
    if (!trigger || !menu) return;

    const natural = menu.offsetHeight;
    const spaceBelow = window.innerHeight - trigger.bottom - EDGE;
    const spaceAbove = trigger.top - EDGE;

    // 原来只写「放不下就往上翻」，翻完再用 Math.max(8, …) 兜底：矮屏上会把一整个 320px
    // 菜单停在 y=8、正好盖住它自己的触发键，下一次点击就落在某个菜单项上、触发一个没打算要的动作。
    // 所以先挑更宽裕的一侧，再把这一侧的可用空间当成菜单的高度上限（超了就内部滚动，绝不越过触发键）。
    const below = spaceBelow >= spaceAbove;
    const room = below ? spaceBelow : spaceAbove;
    const maxHeight = Math.min(natural, MENU_MAX_HEIGHT, room);
    const top = below
      ? Math.min(trigger.bottom + GAP, window.innerHeight - maxHeight - EDGE)
      : trigger.top - maxHeight - GAP;

    const left = Math.min(
      Math.max(EDGE, trigger.right - width),
      Math.max(EDGE, window.innerWidth - width - EDGE)
    );
    setPos({ top, left, maxHeight });
  }, [open, width]);

  useEffect(() => {
    if (!open) return;

    const close = () => setOpen(false);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      close();
    };
    const onScroll = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      close();
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);

    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
      setPos(null);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen((v) => !v)}
        className={`relative z-10 shrink-0 ${TRIGGER_SIZE[size]} rounded-md text-gray-400 transition ${
          open
            ? 'bg-white/15 text-white'
            : 'bg-white/5 hover:bg-white/15 hover:text-white'
        }`}
      >
        ⋯
      </button>

      {open && (
        <div
          ref={menuRef}
          style={{
            position: 'fixed',
            top: pos?.top ?? -9999,
            left: pos?.left ?? -9999,
            width,
            maxHeight: pos?.maxHeight ?? MENU_MAX_HEIGHT,
          }}
          className="z-50 overflow-y-auto rounded-lg border border-white/10 bg-[#1b1b24] shadow-xl shadow-black/50 py-1"
        >
          {items.map((item, i) => {
            if (item.kind === 'label') {
              return (
                <div key={i} className="px-3 pt-1.5 pb-1 text-[11px] text-gray-500">
                  {item.label}
                </div>
              );
            }
            if (item.kind === 'divider') {
              return <div key={i} className="my-1 border-t border-white/10" />;
            }
            return (
              <button
                key={i}
                type="button"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onClick();
                }}
                className={`w-full text-left px-3 ${ROW_SIZE[size]} flex items-center justify-between gap-2 transition disabled:opacity-40 ${
                  item.tone === 'danger'
                    ? 'text-red-400 hover:bg-red-500/10'
                    : 'text-gray-200 hover:bg-white/10'
                }`}
              >
                <span className="truncate">{item.label}</span>
                {item.checked && <span className="text-blue-400 shrink-0">✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
