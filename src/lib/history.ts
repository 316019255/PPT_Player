/**
 * 撤销栈：只存「这一步改之前长什么样」，压栈时机由调用方决定。
 *
 * 单独抽成无依赖的纯模块，是因为麻烦的都在这里的两件事上：
 * 同一次手势（打字、拖角、拖滑杆、拖取色器）会连着触发几十上百次改动，
 * 每次都记一步的话「撤销」只能退回半个字；反过来全并成一步又会把
 * 「改粗体」和「改颜色」这种两件事吞成一件。所以按「改了哪些字段」分组，
 * 同组且在时间窗内才算一步。
 */

export interface HistoryEntry<T> {
  /** 这一步之前的状态 */
  state: T;
  /** 属于哪一次连续操作；null 表示这一步永远单独算 */
  group: string | null;
  /** 压栈（或最近一次并入）的时间戳 */
  at: number;
}

/** 同一个组里继续改，隔多久以内还算同一步 */
export const GROUP_WINDOW_MS = 1000;
/** 栈最多留几步：够一路撤回去，又不至于把整个 deck 的历史都留在内存里 */
export const HISTORY_MAX = 60;

/**
 * 会连着触发的字段。滑杆、输入框、取色器、拖拽都在改这几个，一次手势就是几十次调用；
 * 其余字段（颜色以外的对齐、粗斜、层级、fit…）都是「点一次算一次」的独立意图。
 */
const CONTINUOUS_FIELDS = new Set([
  'text',
  'fontSize',
  'x',
  'y',
  'width',
  'height',
  'opacity',
  'padding',
  'borderRadius',
  'borderColor',
  'borderWidth',
  'color',
  'bgColor',
]);

/**
 * 一次块级改动属于哪一组：改的字段全在连续名单里才可能并步，组名就是「字段集合 + 哪一页的哪一块」。
 * 于是打字合成一步、拖角合成一步，而紧接着点「粗体」仍然是单独一步。
 * 返回 null 表示不并。
 */
export function editGroup(fields: string[], slideId: string, blockId: string): string | null {
  if (fields.length === 0) return null;
  if (!fields.every((f) => CONTINUOUS_FIELDS.has(f))) return null;
  return `${[...new Set(fields)].sort().join('+')}:${slideId}:${blockId}`;
}

/**
 * 压一步。同组且距上一次不到 GROUP_WINDOW_MS 就只把时间往后挪 —— 栈里留下的还是
 * 这一串改动开始之前的样子，撤销一次就退回整串。
 */
export function pushHistory<T>(
  past: HistoryEntry<T>[],
  state: T,
  group: string | null,
  now: number
): HistoryEntry<T>[] {
  const last = past[past.length - 1];
  if (group && last && last.group === group && now - last.at < GROUP_WINDOW_MS) {
    return [...past.slice(0, -1), { ...last, at: now }];
  }
  const next = [...past, { state, group, at: now }];
  return next.length > HISTORY_MAX ? next.slice(next.length - HISTORY_MAX) : next;
}

/**
 * 退一步：弹出栈顶，把它的「改之前」交回去，同时把刚退出来的这一次压成新的栈顶之外的那些。
 * 这里只负责取，怎么把 state 落到 store 里由调用方管（撤销本身不该再记一步）。
 */
export function takeLast<T>(past: HistoryEntry<T>[]): { entry: HistoryEntry<T>; past: HistoryEntry<T>[] } | null {
  const entry = past[past.length - 1];
  if (!entry) return null;
  return { entry, past: past.slice(0, -1) };
}

/**
 * 撤销之后把新的栈顶「封口」：组名作废，紧接着的改动一定另起一步。
 * 不封的话，「打字 → 撤 → 再打字」里新打的那串可能并进下面那一步（同组、又在时间窗内），
 * 再按一次撤销就会连着跳过用户自己刚做的那一串。
 */
export function sealTop<T>(past: HistoryEntry<T>[]): HistoryEntry<T>[] {
  const last = past[past.length - 1];
  if (!last || last.group === null) return past;
  return [...past.slice(0, -1), { ...last, group: null }];
}
