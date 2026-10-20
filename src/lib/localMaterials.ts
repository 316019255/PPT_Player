'use client';

import { useEffect, useState } from 'react';

import {
  FOLDER_STORE,
  STORE,
  THUMB_STORE,
  notifyLocalStore,
  subscribeLocalStore,
  withStore,
} from './localDb.ts';

/**
 * 浏览器端「本地素材」：把用户自己电脑上的图片/视频存进 IndexedDB，
 * 幻灯片背景只保存 `local:<key>` 引用，文件字节永不上传服务器。
 * 换浏览器/换 origin（含 dev↔prod）时本地库不存在 → 背景退化成纯色，不报错、不发请求。
 *
 * 连接和变化订阅在 ./localDb；这里只放素材语义。
 * 依赖约束：只在函数体内碰 crypto / navigator / URL，
 * 模块顶层不执行任何 DOM API，SSR 导入安全。
 */

/** 用户授权的素材文件夹句柄；可结构化克隆存下来，但重新打开网页后权限要再授一次 */
const FOLDER_KEY = 'folder';
/** 单个本地素材上限；本机库的容量由这台机器说了算，比云端桶那张 12MB 的单图上限宽松 */
const MAX_MATERIAL_BYTES = 200 * 1024 * 1024;
/** 网格预览的最大宽度：预览只碰这张小图，绝不解码原文件 */
const THUMB_MAX_W = 320;
const THUMB_QUALITY = 0.72;

export const LOCAL_PREFIX = 'local:';

export type MaterialKind = 'image' | 'video';

export interface LocalMaterialMeta {
  key: string;
  name: string;
  kind: MaterialKind;
  mime: string;
  size: number;
  createdAt: number;
}

interface LocalMaterialRecord extends LocalMaterialMeta {
  blob: Blob;
}

export type LocalMaterialResult =
  | { status: 'pending' }
  | { status: 'ready'; url: string; kind: MaterialKind; name: string }
  | { status: 'missing' }
  | { status: 'error'; reason: string };

/** 预览图存在 thumbs 库里，用同一个 key 索引；v2 之前导入的老素材没有 → blank */
export type LocalThumbResult =
  | { status: 'pending' }
  | { status: 'ready'; url: string }
  | { status: 'missing' }
  | { status: 'blank' }
  | { status: 'error'; reason: string };

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.ogg', '.ogv', '.mov', '.m4v']);
const EXT_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'video/ogg',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
};

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i).toLowerCase();
}

/** svg/html 一律拒绝（矢量注入/可执行风险），gif 保留 */
function detectKind(file: File): MaterialKind | null {
  if (file.type === 'image/svg+xml') return null;
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  const e = extOf(file.name);
  if (e === '.svg' || e === '.html' || e === '.htm') return null;
  if (IMAGE_EXTS.has(e)) return 'image';
  if (VIDEO_EXTS.has(e)) return 'video';
  return null;
}

function mimeOf(file: File, kind: MaterialKind): string {
  return file.type || EXT_MIME[extOf(file.name)] || (kind === 'video' ? 'video/*' : 'image/*');
}

function toMeta(rec: LocalMaterialRecord): LocalMaterialMeta {
  return { key: rec.key, name: rec.name, kind: rec.kind, mime: rec.mime, size: rec.size, createdAt: rec.createdAt };
}

export function localRefValue(key: string): string {
  return LOCAL_PREFIX + key;
}

/** 引用计数 objectURL 缓存：同一 key 的多处渲染（编辑器/500 张缩略图/放映）共用一个 blob: URL */
const urlCache = new Map<string, { url: string; refs: number }>();

function acquireUrl(key: string, blob: Blob): string {
  const hit = urlCache.get(key);
  if (hit) {
    hit.refs += 1;
    return hit.url;
  }
  const url = URL.createObjectURL(blob);
  urlCache.set(key, { url, refs: 1 });
  return url;
}

function releaseUrl(key: string): void {
  const hit = urlCache.get(key);
  if (!hit) return;
  hit.refs -= 1;
  if (hit.refs <= 0) {
    URL.revokeObjectURL(hit.url);
    urlCache.delete(key);
  }
}

/** 强制回收（删除素材时用），无视剩余引用 */
function dropUrl(key: string): void {
  const hit = urlCache.get(key);
  if (!hit) return;
  URL.revokeObjectURL(hit.url);
  urlCache.delete(key);
}

let persistRequested = false;
function requestPersistence(): void {
  if (persistRequested) return;
  persistRequested = true;
  try {
    void navigator.storage?.persist?.().catch(() => {});
  } catch {
    /* 私有模式/不支持时忽略 */
  }
}

export async function getMaterial(key: string): Promise<LocalMaterialRecord | null> {
  if (!key) return null;
  return withStore(STORE, 'readonly', (tx) =>
    new Promise<LocalMaterialRecord | null>((resolve, reject) => {
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as LocalMaterialRecord | undefined) ?? null);
      req.onerror = () => reject(req.error ?? new Error('读取失败'));
    }),
  );
}

/** 只读 thumbs 库；网格预览走这条路，原始 blob 一次都不解码、不克隆 */
async function getThumbBlob(key: string): Promise<Blob | null> {
  if (!key) return null;
  return withStore(THUMB_STORE, 'readonly', (tx) =>
    new Promise<Blob | null>((resolve, reject) => {
      const req = tx.objectStore(THUMB_STORE).get(key);
      req.onsuccess = () => resolve((req.result as Blob | undefined) ?? null);
      req.onerror = () => reject(req.error ?? new Error('读取失败'));
    }),
  );
}

/** 用游标投影元数据，绝不 getAll()（那会把每个 Blob 都载入内存） */
export async function listMaterials(): Promise<LocalMaterialMeta[]> {
  const metas = await withStore(STORE, 'readonly', (tx) =>
    new Promise<LocalMaterialMeta[]>((resolve, reject) => {
      const out: LocalMaterialMeta[] = [];
      const req = tx.objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (cur) {
          out.push(toMeta(cur.value as LocalMaterialRecord));
          cur.continue();
          return;
        }
        resolve(out);
      };
      req.onerror = () => reject(req.error ?? new Error('读取失败'));
    }),
  );
  return metas.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * 「同一个素材」的判定：名字 + 体积 + MIME 都相同就算没变。
 * 文件夹扫描和手动添加共用这一条规则，不然两处会各留一份重复项。
 */
export function isSameMaterial(
  meta: LocalMaterialMeta,
  file: { name: string; size: number; mime: string },
): boolean {
  return meta.name === file.name && meta.size === file.size && meta.mime === file.mime;
}

/** File 的 MIME 在 .type 上而不是 .mime，判定用的形状统一在这里拼，免得每个调用方各踩一次坑 */
function probeOf(file: File, mime: string): { name: string; size: number; mime: string } {
  return { name: file.name, size: file.size, mime };
}

/**
 * 一批入库共用的查重表：按名字分桶，桶里再用 isSameMaterial 定同一张。
 *
 * 为什么要有它：putMaterial 存每张图前都要确认库里没有同一张，而库里没有可按名字查的索引，
 * 只能开一趟全库游标。于是一个 300 项的文件夹扫描、或一份带 100 张图的 pptx，就是几百趟全库读，
 * 耗时随库大小平方增长。这张表把那几百趟压成一趟。
 *
 * 它只在所属的那一批（一次扫描 / 一次导入）里活命，故意不跨批缓存：
 * 别的标签页刚存进去的素材，下一批照样看得见，不会为了省一趟读而留下重复项。
 */
export interface MaterialDupTable {
  find(probe: { name: string; size: number; mime: string }): LocalMaterialMeta | null;
  remember(meta: LocalMaterialMeta): void;
}

export async function createMaterialDupTable(): Promise<MaterialDupTable> {
  const byName = new Map<string, LocalMaterialMeta[]>();
  for (const meta of await listMaterials()) {
    const bucket = byName.get(meta.name);
    if (bucket) bucket.push(meta);
    else byName.set(meta.name, [meta]);
  }
  return {
    find: (probe) => byName.get(probe.name)?.find((m) => isSameMaterial(m, probe)) ?? null,
    remember: (meta) => {
      const bucket = byName.get(meta.name);
      if (bucket) bucket.push(meta);
      else byName.set(meta.name, [meta]);
    },
  };
}

/** 把画布编成 JPEG；优先 OffscreenCanvas，老浏览器回落 DOM canvas */
async function encodeJpeg(
  w: number,
  h: number,
  draw: (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) => void,
): Promise<Blob> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建缩略图画布');
    draw(ctx);
    return canvas.convertToBlob({ type: 'image/jpeg', quality: THUMB_QUALITY });
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建缩略图画布');
  draw(ctx);
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('缩略图编码失败'))), 'image/jpeg', THUMB_QUALITY),
  );
}

/** 限宽解码：解不开就抛错（InvalidStateError 等），坏字节到不了 IndexedDB */
async function decodeImageScaled(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { resizeWidth: THUMB_MAX_W, resizeQuality: 'high' });
  } catch (err) {
    // 不认识 resize 选项的浏览器会报 NotSupportedError，退化成全量解码；真正的坏文件仍然在这里抛
    if (err instanceof DOMException && err.name === 'NotSupportedError') return createImageBitmap(file);
    throw err;
  }
}

/** 图片：一次 320px 解码同时当「能不能解」的校验和网格缩略图 */
async function probeImageThumb(file: File): Promise<Blob> {
  const bmp = await decodeImageScaled(file);
  try {
    return await encodeJpeg(bmp.width, bmp.height, (ctx) => {
      ctx.fillStyle = '#1a1a2e'; // JPEG 没有透明通道，先铺一层和放映兜底一致的底色
      ctx.fillRect(0, 0, bmp.width, bmp.height);
      ctx.drawImage(bmp, 0, 0, bmp.width, bmp.height);
    });
  } finally {
    bmp.close();
  }
}

function afterEvent(el: HTMLElement, ok: string, fail: string, onSetup: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    el.addEventListener(ok, () => resolve(), { once: true });
    el.addEventListener(fail, () => reject(new Error('解码失败')), { once: true });
    onSetup();
  });
}

/** 视频：抓一帧。抓得到就说明这台浏览器播得动，顺手当缩略图；抓不到就别入库 */
async function probeVideoThumb(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  try {
    await withTimeout(afterEvent(video, 'loadedmetadata', 'error', () => (video.src = url)), 10000);
    const duration = Number.isFinite(video.duration) ? video.duration : 1;
    await withTimeout(
      afterEvent(video, 'seeked', 'error', () => (video.currentTime = Math.min(0.1, duration / 2))),
      10000,
    );
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) throw new Error('视频没有有效画面');
    const scale = Math.min(1, THUMB_MAX_W / vw);
    const w = Math.max(1, Math.round(vw * scale));
    const h = Math.max(1, Math.round(vh * scale));
    return await encodeJpeg(w, h, (ctx) => ctx.drawImage(video, 0, 0, w, h));
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`处理超时（${ms / 1000}s）`)), ms);
    p.then((v) => {
      clearTimeout(timer);
      resolve(v);
    }, reject);
  });
}

export async function putMaterial(file: File, dup?: MaterialDupTable): Promise<LocalMaterialMeta> {
  const kind = detectKind(file);
  if (!kind) throw new Error('只支持图片（jpg/png/webp/gif/avif…）或视频（mp4/webm/mov…）文件');
  if (file.size > MAX_MATERIAL_BYTES) {
    throw new Error(`文件太大（上限 ${Math.round(MAX_MATERIAL_BYTES / 1024 / 1024)}MB）`);
  }
  const mime = mimeOf(file, kind);
  const probe = probeOf(file, mime);
  // 批量导入把表传进来（一趟全库读供整批用）；单文件添加没有表就现建一趟
  const table = dup ?? (await createMaterialDupTable());
  const hit = table.find(probe);
  if (hit) return hit;

  // 先证明这台浏览器解得开再落库：坏文件存进去只会在放映时变成黑块，退都退不回来
  let thumb: Blob;
  try {
    thumb = kind === 'image' ? await probeImageThumb(file) : await probeVideoThumb(file);
  } catch (err) {
    const reason = err instanceof Error ? err.message : '未知错误';
    throw new Error(
      kind === 'image' ? `这张图片浏览器解不开（文件可能已损坏或格式不支持）：${reason}` : `这个视频当前浏览器放不了：${reason}`,
    );
  }

  const key = crypto.randomUUID();
  const record: LocalMaterialRecord = {
    key,
    name: file.name,
    kind,
    mime,
    size: file.size,
    createdAt: Date.now(),
    blob: file,
  };
  await withStore([STORE, THUMB_STORE], 'readwrite', (tx) =>
    new Promise<void>((resolve, reject) => {
      tx.objectStore(STORE).put(record);
      tx.objectStore(THUMB_STORE).put(thumb, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('保存失败'));
      tx.onabort = () => reject(tx.error ?? new Error('保存被中断，可能超出存储配额'));
    }),
  );
  requestPersistence();
  const meta = toMeta(record);
  // 这一张也得进表，否则同一批里紧接着的同名同体积文件会各存一份
  table.remember(meta);
  notifyLocalStore(key);
  notifyLocalStore(thumbSlot(key));
  return meta;
}

export async function removeMaterial(key: string): Promise<void> {
  await withStore([STORE, THUMB_STORE], 'readwrite', (tx) =>
    new Promise<void>((resolve, reject) => {
      tx.objectStore(STORE).delete(key);
      tx.objectStore(THUMB_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('删除失败'));
      tx.onabort = () => reject(tx.error ?? new Error('删除失败'));
    }),
  );
  dropUrl(key);
  dropUrl(thumbSlot(key));
  notifyLocalStore(key);
  notifyLocalStore(thumbSlot(key));
}

export function totalBytes(metas: LocalMaterialMeta[]): number {
  return metas.reduce((n, m) => n + m.size, 0);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 预览图在 URL 缓存里单独占一个槽位，避免和同一 key 的原始 blob 撞车 */
function thumbSlot(key: string): string {
  return `thumb:${key}`;
}

/* -------------------------------------------------------------------------
 * 素材文件夹：用户指定本机一个目录，之后把图片/视频丢进去就行，扫描时增量入库。
 * showDirectoryPicker 只有 Chromium 有；句柄能存进 IndexedDB，但重新打开网页后
 * 权限回落到 prompt，必须用户再点一次授权（浏览器安全规则，绕不过去）。
 * ----------------------------------------------------------------------- */

type FsPermission = 'granted' | 'denied' | 'prompt';

/** lib.dom 没有声明这几个 Chromium 扩展，按实际用到的形状自己补 */
interface FsDirHandle extends FileSystemDirectoryHandle {
  queryPermission?(options: { mode?: 'read' | 'readwrite' }): Promise<FsPermission>;
  requestPermission?(options: { mode?: 'read' | 'readwrite' }): Promise<FsPermission>;
  values(): AsyncIterableIterator<FileSystemFileHandle | FileSystemDirectoryHandle>;
}

interface FsFolderRecord {
  name: string;
  handle: FsDirHandle;
  savedAt: number;
}

type FsWindow = Window & typeof globalThis & { showDirectoryPicker?: () => Promise<FsDirHandle> };

export interface FolderStatus {
  name: string;
  permission: FsPermission;
}

export interface FolderScanProgress {
  done: number;
  total: number;
  name: string;
}

export interface FolderScanReport {
  added: LocalMaterialMeta[];
  unchanged: number;
  unsupported: number;
  failed: { name: string; reason: string }[];
}

/** 支持与否要在点击时才知道（SSR 阶段没有 window），所以做成函数而不是常量 */
export function supportsFolderPicker(): boolean {
  return typeof window !== 'undefined' && typeof (window as FsWindow).showDirectoryPicker === 'function';
}

async function getFolderRecord(): Promise<FsFolderRecord | null> {
  return withStore(FOLDER_STORE, 'readonly', (tx) =>
    new Promise<FsFolderRecord | null>((resolve, reject) => {
      const req = tx.objectStore(FOLDER_STORE).get(FOLDER_KEY);
      req.onsuccess = () => resolve((req.result as FsFolderRecord | undefined) ?? null);
      req.onerror = () => reject(req.error ?? new Error('读取素材文件夹失败'));
    }),
  );
}

/** 老版本没有 queryPermission 时，刚授权完必然可用，当作 granted */
async function permissionOf(handle: FsDirHandle): Promise<FsPermission> {
  if (!handle.queryPermission) return 'granted';
  try {
    return await handle.queryPermission({ mode: 'read' });
  } catch {
    return 'denied';
  }
}

export async function getFolderStatus(): Promise<FolderStatus | null> {
  const rec = await getFolderRecord();
  if (!rec) return null;
  return { name: rec.name, permission: await permissionOf(rec.handle) };
}

/** 必须由用户手势调用；用户在系统弹窗里取消时抛 AbortError，调用方要当无事发生 */
export async function pickFolder(): Promise<FolderStatus> {
  const picker = typeof window === 'undefined' ? undefined : (window as FsWindow).showDirectoryPicker;
  if (!picker) throw new Error('这个浏览器不支持选择文件夹，请改用 Chrome 或 Edge');
  const handle = await picker.call(window);
  const rec: FsFolderRecord = { name: handle.name, handle, savedAt: Date.now() };
  await withStore(FOLDER_STORE, 'readwrite', (tx) =>
    new Promise<void>((resolve, reject) => {
      tx.objectStore(FOLDER_STORE).put(rec, FOLDER_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('保存文件夹失败'));
      tx.onabort = () => reject(tx.error ?? new Error('保存文件夹失败'));
    }),
  );
  return { name: rec.name, permission: await permissionOf(handle) };
}

/** 也要由用户手势调用：重新打开网页后靠它把文件夹权限要回来 */
export async function authorizeFolder(): Promise<FsPermission> {
  const rec = await getFolderRecord();
  if (!rec) return 'denied';
  if (!rec.handle.requestPermission) return permissionOf(rec.handle);
  try {
    return await rec.handle.requestPermission({ mode: 'read' });
  } catch {
    return 'denied';
  }
}

/** 只是忘记这个文件夹，已经入库的素材一个都不动 */
export async function forgetFolder(): Promise<void> {
  await withStore(FOLDER_STORE, 'readwrite', (tx) =>
    new Promise<void>((resolve, reject) => {
      tx.objectStore(FOLDER_STORE).delete(FOLDER_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('断开失败'));
      tx.onabort = () => reject(tx.error ?? new Error('断开失败'));
    }),
  );
}

/**
 * 扫描已连接的文件夹。便宜的步骤在前：列目录只拿到句柄，getFile() 也只拿元数据，
 * 库里已有的直接跳过（一张覆盖整批的查重表 = 全程只读一次全库），
 * 只有真正的新文件才被 putMaterial 解一次码。
 * 必须串行：并发解码等于把整个文件夹的原图同时拉进内存。
 */
export async function scanFolder(onProgress?: (p: FolderScanProgress) => void): Promise<FolderScanReport> {
  const rec = await getFolderRecord();
  if (!rec) throw new Error('还没有连接素材文件夹');
  if ((await permissionOf(rec.handle)) !== 'granted') {
    throw new Error(`需要重新授权「${rec.name}」（重新打开网页后浏览器会忘记这个文件夹）`);
  }

  const handles: FileSystemFileHandle[] = [];
  const iter = rec.handle.values();
  for (;;) {
    const step = await iter.next();
    if (step.done) break;
    const entry = step.value;
    // 只看这一层，不进子文件夹；点开头的（.DS_Store / Thumbs.db）不是素材
    if (entry.kind !== 'file' || entry.name.startsWith('.')) continue;
    handles.push(entry);
  }

  const dup = await createMaterialDupTable();
  const report: FolderScanReport = { added: [], unchanged: 0, unsupported: 0, failed: [] };
  let done = 0;
  for (const fh of handles) {
    onProgress?.({ done: ++done, total: handles.length, name: fh.name });
    let file: File;
    try {
      file = await fh.getFile();
    } catch (err) {
      report.failed.push({ name: fh.name, reason: err instanceof Error ? err.message : '读取失败' });
      continue;
    }
    const kind = detectKind(file);
    if (!kind) {
      report.unsupported++;
      continue;
    }
    if (file.size > MAX_MATERIAL_BYTES) {
      report.failed.push({ name: file.name, reason: `太大（上限 ${Math.round(MAX_MATERIAL_BYTES / 1024 / 1024)}MB）` });
      continue;
    }
    if (dup.find(probeOf(file, mimeOf(file, kind)))) {
      report.unchanged++;
      continue;
    }
    try {
      const meta = await putMaterial(file, dup);
      report.added.push(meta);
    } catch (err) {
      report.failed.push({ name: file.name, reason: err instanceof Error ? err.message : '入库失败' });
    }
  }
  return report;
}

/**
 * 解析一个 `local:<key>` 引用为可渲染的 blob: URL。
 * StrictMode 下 effect 会「挂载→卸载→再挂载」：先 acquire→release(revoke)→再 acquire，
 * 序列是对的（只多一次读），别把 revoke 去掉，否则换 key 时会漏 URL。
 */
export function useLocalMaterial(key: string): LocalMaterialResult {
  const [tick, setTick] = useState(0);
  const [result, setResult] = useState<LocalMaterialResult>({ status: 'pending' });

  // 只听自己这一格：整库广播时删一张图会把所有在显示的格子全刷一遍
  useEffect(
    () => (key ? subscribeLocalStore(key, () => setTick((n) => n + 1)) : undefined),
    [key],
  );

  useEffect(() => {
    if (!key) {
      // 不空跑 IndexedDB：异步回填，避免在 effect 体内同步 setState 触发级联渲染
      let done = false;
      Promise.resolve().then(() => {
        if (!done) setResult({ status: 'missing' });
      });
      return () => {
        done = true;
      };
    }
    let cancelled = false;
    let acquired = false;
    getMaterial(key)
      .then((rec) => {
        if (cancelled) return;
        if (!rec) {
          setResult({ status: 'missing' });
          return;
        }
        acquired = true;
        setResult({ status: 'ready', url: acquireUrl(key, rec.blob), kind: rec.kind, name: rec.name });
      })
      .catch((err) => {
        if (!cancelled) setResult({ status: 'error', reason: err instanceof Error ? err.message : '读取失败' });
      });
    return () => {
      cancelled = true;
      // acquired 与 cleanup 闭包共享同一绑定：异步完成前被清理则 acquired=false，不释放
      if (acquired) releaseUrl(key);
      // key/tick 变化或卸载时复位，下一次运行从 pending 开始，而不是 effect 体内同步 setState
      setResult({ status: 'pending' });
    };
  }, [key, tick]);

  return result;
}

/** count() 只判断存在性，不会把 blob 反序列化进内存 */
async function hasMaterial(key: string): Promise<boolean> {
  return withStore(STORE, 'readonly', (tx) =>
    new Promise<boolean>((resolve, reject) => {
      const req = tx.objectStore(STORE).count(key);
      req.onsuccess = () => resolve(req.result > 0);
      req.onerror = () => reject(req.error ?? new Error('读取失败'));
    }),
  );
}

/**
 * 网格预览专用：只解析 thumbs 库里那张 ~10KB 的 JPEG。
 * 原始素材（可能是 4K JPEG 或几百 MB 视频）在这里一次都不读——
 * 40 个格子各解一张 4K 图会吃掉近 2GB 位图内存，而这台设备只是想看一眼列表。
 */
export function useLocalThumb(key: string): LocalThumbResult {
  const [tick, setTick] = useState(0);
  const [result, setResult] = useState<LocalThumbResult>({ status: 'pending' });

  // 预览图和原始素材各占一个通知槽位，网格只听自己那张小图
  useEffect(
    () => (key ? subscribeLocalStore(thumbSlot(key), () => setTick((n) => n + 1)) : undefined),
    [key],
  );

  useEffect(() => {
    if (!key) {
      let done = false;
      Promise.resolve().then(() => {
        if (!done) setResult({ status: 'missing' });
      });
      return () => {
        done = true;
      };
    }
    let cancelled = false;
    let acquired = false;
    getThumbBlob(key)
      .then(async (thumb) => {
        if (cancelled) return;
        if (thumb) {
          acquired = true;
          setResult({ status: 'ready', url: acquireUrl(thumbSlot(key), thumb) });
          return;
        }
        setResult({ status: (await hasMaterial(key)) ? 'blank' : 'missing' });
      })
      .catch((err) => {
        if (!cancelled) setResult({ status: 'error', reason: err instanceof Error ? err.message : '读取失败' });
      });
    return () => {
      cancelled = true;
      if (acquired) releaseUrl(thumbSlot(key));
      setResult({ status: 'pending' });
    };
  }, [key, tick]);

  return result;
}
