/**
 * 自动保存的节流算法（纯函数，不含 DOM/网络，好测）。
 *
 * 两条约束叠在一起：
 * - 空闲计时：手停下来 id 毫秒才落库，打字途中一趟都不发（每趟都是一次东京往返 + 一次函数计费）。
 * - 强制上限：距上一次尝试攒够 maxAge 就立刻落 —— 不然一直打字的人能把保存无限期推下去，
 *   「自动保存」在他那儿等于没有，重试退避也能被拉成好几分钟。
 * 上限跟着「上一次尝试」走，不是跟着「第一次变脏」走：一次失败之后稿子本来就脏过 30 秒了，
 * 还按脏多久算就永远返回 0，退避直接变成空转，服务端越错越被打得狠。
 */

/** 手停下来多久算「这段改完了」 */
export const AUTOSAVE_IDLE_MS = 8_000;
/** 距上一次尝试最长等多久必须再落一次库 */
export const AUTOSAVE_MAX_AGE_MS = 30_000;
/** 本地日志的落盘节奏：比自动保存勤得多，因为它不打网络 */
export const DRAFT_WRITE_IDLE_MS = 400;

/** 保存失败后的重试上限，超过就停手交给用户 */
export const MAX_RETRIES = 3;

export interface SaveTiming {
  /** 上一次尝试保存的时刻；刚变脏还没试过就用变脏那一刻 */
  sinceAttempt: number;
  now?: number;
  retryTick?: number;
  idleMs?: number;
  maxAgeMs?: number;
}

/** 从现在起还要等多久才落库（0 = 立刻） */
export function computeSaveInMs({
  sinceAttempt,
  now = Date.now(),
  retryTick = 0,
  idleMs = AUTOSAVE_IDLE_MS,
  maxAgeMs = AUTOSAVE_MAX_AGE_MS,
}: SaveTiming): number {
  const idleAt = now + idleMs * 2 ** retryTick;
  const ceilingAt = sinceAttempt + maxAgeMs;
  return Math.max(0, Math.min(idleAt, ceilingAt) - now);
}

/** 一份可比对的内容快照：草稿和服务器就比这两样 */
export interface Snapshot {
  title: string;
  slides: unknown[];
}

/**
 * 本机草稿是否比手上的内容多东西 —— 是就多，不猜时间戳：
 * 服务器那一行的 updated_at 前端拿不到，跨设备时钟更不可信，唯一站得住的判据是「内容一样不一样」。
 * 键序不同会误报成「不一样」，代价只是多弹一次询问，用户点「丢弃」就没了；
 * 反过来漏报会丢内容，所以这里宁可误报。
 */
export function draftIsAhead(server: Snapshot, draft: Snapshot | null): boolean {
  if (!draft) return false;
  return (
    JSON.stringify({ title: draft.title, slides: draft.slides }) !==
    JSON.stringify({ title: server.title, slides: server.slides })
  );
}
