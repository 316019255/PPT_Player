/**
 * 背景片源解析的唯一口径：放映舞台按它决定「这一页挂哪条视频、跨页要不要续播」，
 * 预热按它决定「下一条该提前拉哪个」。两边各写一份必然漂移 —— 预热会去 fetch 一个
 * 桶内相对路径，或者舞台把同一条视频当两条新的重挂一遍（那就又回到「翻页从头播」）。
 *
 * 身份（id）和地址（url）分开问，是因为本机素材的地址要等 IndexedDB：
 * 舞台只能在同一帧里拿到 id 就把层留着（跨页不重挂），真正的 src 由那层自己异步填。
 *
 * src/lib/* 要能被 Node 直跑的单测引用：只准相对 import 且带 .ts 后缀。
 */
import { cloudPublicUrl, LOCAL_PREFIX } from './media-source.ts';
import { storedVideoExt } from './media-ext.ts';

interface BackgroundLike {
  type: string;
  value: string;
}

interface SlideLike {
  background?: BackgroundLike;
}

/**
 * 这一页的背景该不该挂一条会动的背景，挂的话身份是什么。
 * 返回 deck 里存的那个串（外链就是它本身，本机是 `local:<key>`，云端是桶内路径），
 * 层按它存活：同一个串跨页复用同一个 DOM 元素，所以视频不会从头再播。
 *
 * `local` 不看素材到底是图还是视频 —— 那是异步查库才知道的，而层必须在同一帧就决定去留。
 * 分辨出来的图片背景由那一层自己画成图片，不会挂错 `<video>`。
 */
export function videoSourceId(bg: BackgroundLike | undefined): string | null {
  if (!bg) return null;
  switch (bg.type) {
    case 'video':
    case 'local':
      return bg.value || null;
    case 'cloud':
      // 后缀是唯一的类型线索；公开读前缀没配好就拼不出地址，那一页按静态背景降级
      return storedVideoExt(bg.value) && cloudPublicUrl(bg.value) !== '' ? bg.value : null;
    default:
      return null;
  }
}

/**
 * 身份串 → 真能挂到 `<video src>` 上的地址。本机素材的地址由调用方从库里解析后传入，
 * 还没解析出来就是 ''（那一层等着，别拿空串去发请求）。
 */
export function videoSourceUrl(bg: BackgroundLike, localVideoUrl: string | null): string {
  switch (bg.type) {
    case 'video':
      return bg.value;
    case 'cloud':
      return cloudPublicUrl(bg.value);
    case 'local':
      return localVideoUrl ?? '';
    default:
      return '';
  }
}

/**
 * 背景层栈用的身份：视频按片源算，纯色/图片**也算**。
 * 只给视频算的话，纯色页换到视频页的那一帧上一页底色就没了，新层淡入的 0.8 秒底下是舞台的黑底 ——
 * 实测 33/320 个样本整屏没有被任何满不透明度层铺满，正是「闪一下」本身。
 * 静态背景也进栈，屏幕才永远有一层不透明画面垫着。
 */
export function backgroundLayerId(bg: BackgroundLike | undefined): string {
  const video = videoSourceId(bg);
  if (video) return video;
  if (!bg || !bg.value) return '';
  return bg.type === 'color' || bg.type === 'image' || bg.type === 'cloud' ? `${bg.type}:${bg.value}` : '';
}

/**
 * 会不会「等首帧」的那类背景。两层都是静态时直接硬切、不溶解：
 * 编辑器里拖色板是连续改 value，溶解会让色块慢慢糊过去，而静态背景本来就没有需要等的画面。
 */
export function isStaticBackground(bg: BackgroundLike | undefined): boolean {
  if (!bg) return false;
  if (bg.type === 'color' || bg.type === 'image') return true;
  // 云端那一支：后缀是视频的就归层栈的视频档，剩下才按静态图片算
  return bg.type === 'cloud' && !storedVideoExt(bg.value);
}

/** 往后最多看这么多页：连找四页还没有别的片源，就说明这一大段是同一条视频，不值得再热 */
const MAX_LOOKAHEAD = 4;

/**
 * 往后找第一个「和本页不同」的视频片源地址。同一条视频连铺几页是常见排版（歌词一页一句），
 * 那种页之间根本不用预热；中间夹着图片/纯色页也不打断，因为再往后翻还是会撞上那条新视频。
 *
 * 本机素材（`local:`）返回 ''：blob URL 要异步读库，而那条路径由素材缓存自己负责，不走网络。
 */
export function nextVideoSourceUrl(slides: SlideLike[], from: number, currentId: string | null): string {
  const end = Math.min(slides.length, from + 1 + MAX_LOOKAHEAD);
  for (let i = from + 1; i < end; i++) {
    const bg = slides[i]?.background;
    if (!bg) continue;
    const id = videoSourceId(bg);
    if (!id || id === currentId) continue;
    if (id.startsWith(LOCAL_PREFIX)) continue;
    const url = videoSourceUrl(bg, null);
    if (url) return url;
  }
  return '';
}
