'use client';

import type { ReactNode } from 'react';
import { SheetShell } from '@/components/PhoneDock';

interface Props {
  title: string;
  hint?: string;
  onClose: () => void;
  /**
   * 键盘起来时整块往上抬；窗里第一行常常就是输入框，不抬的话打字时输入框压在键盘底下。
   * 没有输入框的窗（放映页的遥控器说明）不用管，键盘在那种窗里根本起不来。
   */
  keyboardInset?: number;
  children: ReactNode;
}

/**
 * 手机端抽屉窗的外壳：背板占满一屏、窗贴底占 62% 高，点背板就关。
 * SheetShell 自己不定高度（编辑器里那个高度是按画布算出来的），所以这里给它一个死的盒子。
 *  ✕ 只有 28px（表头 h-9 装不下 44px），所以背板必须也能点关——两个出口里至少有一个是整屏大小。
 */
export default function SheetOverlay({
  title,
  hint,
  onClose,
  keyboardInset = 0,
  children,
}: Props) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-end bg-black/60"
      style={{ paddingBottom: keyboardInset }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full h-[62%]">
        <SheetShell title={title} hint={hint} onClose={onClose}>
          {children}
        </SheetShell>
      </div>
    </div>
  );
}
