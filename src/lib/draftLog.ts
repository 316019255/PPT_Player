'use client';

/**
 * 本机草稿日志：编辑器的内容每次变化都先落进 IndexedDB，再谈上传。
 *
 * 为什么要它：自动保存被拉长到「停下来 8 秒」之后，崩溃、闪退、直接把标签页划掉这几种死法
 * 会连带丢掉最后那几秒的改动。本地写一次是几毫秒、零网络、零函数计费，那就让它当安全网，
 * 上传只负责「同步到别的设备」。
 *
 * 单独开一个库（不复用本地素材那个）：素材库已经 v3 且被一屏缩略图的连接共用，
 * 加一张表要把所有旧标签页的连接顶掉；草稿和素材的生命周期也完全不搭。
 *
 * 失败一律吞掉返回 false/null：草稿是额外的保险，不能反过来把编辑器卡住。
 * 依赖约束：模块顶层不碰 indexedDB / DOM，SSR 导入安全。
 */

import type { Slide } from '@/types/ppt';

const DB_NAME = 'ppt-player-drafts';
const DB_VERSION = 1;
const STORE = 'drafts';

/** 还没建档的稿子统一记在这一把下；POST 出真 id 后立刻迁走并清掉它 */
export const NEW_DECK_KEY = 'new';

export interface DraftRecord {
  id: string;
  title: string;
  slides: Slide[];
  /** 这份草稿最后一次写进本机的时刻（Date.now()），只用来给人看「本机草稿 14:02」 */
  savedAt: number;
}

let dbConn: IDBDatabase | null = null;
let dbOpening: Promise<IDBDatabase> | null = null;

/** 连接一旦被认定失效就只认它自己，别把后来重开的那条误撤掉 */
function forget(db: IDBDatabase): void {
  if (dbConn === db) dbConn = null;
}

function openDb(): Promise<IDBDatabase> {
  if (dbConn) return Promise.resolve(dbConn);
  if (dbOpening) return dbOpening;

  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('此浏览器不支持本机草稿'));
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err instanceof Error ? err : new Error('无法打开本机草稿库'));
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        forget(db);
        db.close();
      };
      db.onclose = () => forget(db);
      dbConn = db;
      // 必须清掉：留着这个已 resolve 的 promise，失效后会原样返回那条已经关掉的连接
      dbOpening = null;
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('无法打开本机草稿库'));
  });

  dbOpening = opening;
  void opening.catch(() => {
    if (dbOpening === opening) dbOpening = null;
  });
  return opening;
}

/**
 * 开事务的唯一入口：调用方拿到的事务必须立刻同步发出第一个请求 ——
 * IndexedDB 一旦发现事务没有排队中的请求就提前收尾，所以这里不能先 await 再把 tx 交出去。
 */
function transact<T>(
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction) => Promise<T>
): Promise<T> {
  return openDb().then((db) => run(db.transaction(STORE, mode)));
}

/** 无痕模式、配额满、浏览器不让开库：都只算「这次没记上」，不往上抛 */
async function swallow<T>(run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch (err) {
    console.warn('[draftLog] 本机草稿读写失败', err);
    return fallback;
  }
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('本机草稿事务失败'));
    tx.onabort = () => reject(tx.error ?? new Error('本机草稿被中断，可能超出存储配额'));
  });
}

function get<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('读取本机草稿失败'));
  });
}

/** 记一份本机草稿；返回是否真的落盘 */
export function writeDraft(id: string, title: string, slides: Slide[]): Promise<boolean> {
  return swallow(
    () =>
      transact('readwrite', (tx) => {
        tx.objectStore(STORE).put({ id, title, slides, savedAt: Date.now() } satisfies DraftRecord);
        return done(tx).then(() => true);
      }),
    false
  );
}

export function readDraft(id: string): Promise<DraftRecord | null> {
  return swallow<DraftRecord | null>(
    () =>
      transact('readonly', (tx) =>
        get(tx.objectStore(STORE).get(id) as IDBRequest<DraftRecord | undefined>).then(
          (found) => found ?? null
        )
      ),
    null
  );
}

export function clearDraft(id: string): Promise<boolean> {
  return swallow(
    () =>
      transact('readwrite', (tx) => {
        tx.objectStore(STORE).delete(id);
        return done(tx).then(() => true);
      }),
    false
  );
}
