'use client';

/**
 * 页内提示条。手机端不用 alert()：系统弹窗会盖住整个页面、点掉之后不留痕迹，
 * 用户回头找不到「刚才那条错误是说的哪一个演示文稿」。
 */
export type Notice = {
  tone: 'warn' | 'error' | 'ok';
  text: string;
};

const TONE = {
  warn: 'bg-yellow-500/10 border-yellow-500/20 text-yellow-200',
  error: 'bg-red-500/10 border-red-500/20 text-red-200',
  ok: 'bg-blue-500/10 border-blue-500/20 text-blue-200',
} as const;

/**
 * 跟着页面往下滚，不 fixed 在视口顶部——顶栏上有 ☰ 和「＋ 新建」，糊上去会把它们盖住。
 * 不自动消失：和编辑器的导入提示、配额横幅一致，也免得用户还没读完就没了。
 * `className` 只换定位：放映页整屏都是绝对定位的浮层，那里没有文档流可待。
 */
export default function NoticeBar({
  notice,
  onClose,
  className = 'mb-4',
}: {
  notice: Notice;
  onClose: () => void;
  className?: string;
}) {
  return (
    <div
      className={`${className} p-3 rounded-lg border text-sm flex items-start justify-between gap-3 ${TONE[notice.tone]}`}
    >
      <span className="flex-1 whitespace-pre-line leading-snug">{notice.text}</span>
      <button
        onClick={onClose}
        className="shrink-0 h-9 px-3 rounded-lg bg-white/10 hover:bg-white/20 text-white/90 text-xs transition"
      >
        知道了
      </button>
    </div>
  );
}
