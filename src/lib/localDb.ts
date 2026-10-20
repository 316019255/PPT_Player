'use client';

/**
 * 本地素材库的底层管道：一条复用的 IndexedDB 连接 + 按 key 的变化订阅。
 *
 * 连接复用：以前每个读写都是 open→用→close 一轮，一屏几十格缩略图就是几十次开库，
 * 删一个素材还会让每个在看的 hook 各自重开一次库再重读。事务不需要靠开关连接来隔离，
 * 浏览器自己会排队；只有别的标签页把库版本改了或删了（onversionchange / onclose）
 * 才丢掉这条连接，让下一次调用重开。
 *
 * 变化订阅按 key 分发：整库广播时，删一张图会把正在显示的所有格子全刷一遍。
 *
 * 依赖约束：模块顶层不碰 indexedDB / DOM，SSR 导入安全。
 */

const DB_NAME = 'ppt-player-local-materials';
/** v2 加了 thumbs（网格预览只读这张小图，不碰原始 blob），v3 加了 folder */
const DB_VERSION = 3;

export const STORE = 'files';
export const THUMB_STORE = 'thumbs';
export const FOLDER_STORE = 'folder';

let dbConn: IDBDatabase | null = null;
let dbOpening: Promise<IDBDatabase> | null = null;

/** 连接一旦被认定失效就只认它自己，别把后来重开的那条误撤掉 */
function forget(db: IDBDatabase): void {
  if (dbConn === db) dbConn = null;
}

export function openLocalDb(): Promise<IDBDatabase> {
  if (dbConn) return Promise.resolve(dbConn);
  if (dbOpening) return dbOpening;

  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('此浏览器不支持本地素材库'));
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err instanceof Error ? err : new Error('无法打开本地素材库'));
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(THUMB_STORE)) db.createObjectStore(THUMB_STORE);
      if (!db.objectStoreNames.contains(FOLDER_STORE)) db.createObjectStore(FOLDER_STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      // 另一个标签页升级/删除库：这条连接随时作废，关掉并让下一次调用重开
      db.onversionchange = () => {
        forget(db);
        db.close();
      };
      db.onclose = () => forget(db);
      dbConn = db;
      // 必须清掉：留着这个已 resolve 的 promise，失效后会原样返回那条关掉的连接
      dbOpening = null;
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('无法打开本地素材库'));
    req.onblocked = () => reject(new Error('本地素材库被其它页面占用，请关闭旧标签后重试'));
  });

  dbOpening = opening;
  // 开库失败不能把坏 promise 留在表上，否则整个页面生命周期都只会重试同一个错误
  void opening.catch(() => {
    if (dbOpening === opening) dbOpening = null;
  });
  return opening;
}

/**
 * 所有事务的唯一入口。
 * 交给调用方的必须是「刚开好、还没跨 await」的事务：IndexedDB 一旦发现事务没有排队中的
 * 请求就提前收尾，所以这里同步调用 run，调用方在里面立刻发出第一个请求。
 * 连接由 openLocalDb 复用，调用方一律不许 close。
 */
export async function withStore<T>(
  storeNames: string | string[],
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction) => Promise<T>
): Promise<T> {
  const db = await openLocalDb();
  return run(db.transaction(storeNames, mode));
}

type Listener = () => void;
const watchers = new Map<string, Set<Listener>>();

export function notifyLocalStore(key: string): void {
  const set = watchers.get(key);
  if (!set) return;
  // 快照一份：通知期间退订不能让后面的监听者被跳过
  for (const l of [...set]) l();
}

export function subscribeLocalStore(key: string, listener: Listener): () => void {
  let set = watchers.get(key);
  if (!set) {
    set = new Set();
    watchers.set(key, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    // 空桶留着会随换过的 key 越攒越多，最后一个监听者走了就撤掉
    if (set.size === 0 && watchers.get(key) === set) watchers.delete(key);
  };
}
