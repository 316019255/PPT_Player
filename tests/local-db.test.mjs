import test from 'node:test';
import assert from 'node:assert/strict';

import { notifyLocalStore, openLocalDb, subscribeLocalStore, withStore } from '../src/lib/localDb.ts';

/**
 * 覆盖 B3 改的两处管道：连接复用 + 按 key 的通知。
 *
 * 这里装的假 indexedDB 只记账（开了几次库、关了几次、事务参数是什么），
 * 它不模拟 IndexedDB 的真实语义 —— 证明的是我们自己的缓存与失效逻辑，
 * 「浏览器允许长期持有同一条连接」这一点由规范保证，不靠这个假件。
 *
 * 连接缓存是进程级的，所以第一个用例按顺序走完整条缓存的生命周期。
 */

const state = { attempts: 0, opens: 0, closes: 0, transactions: [], failOpen: false, lastDb: null };

function installFakeIndexedDb() {
  globalThis.indexedDB = {
    open() {
      state.attempts += 1;
      const req = {};
      if (state.failOpen) {
        queueMicrotask(() => {
          req.error = new Error('mock：开库失败');
          req.onerror?.();
        });
        return req;
      }
      state.opens += 1;
      const db = {
        objectStoreNames: { contains: () => true },
        createObjectStore() {},
        close() {
          state.closes += 1;
        },
        transaction(names, mode) {
          state.transactions.push(`${[].concat(names).join('+')}=${mode}`);
          return { objectStore: () => ({}) };
        },
      };
      state.lastDb = db;
      queueMicrotask(() => {
        req.result = db;
        req.onsuccess?.();
      });
      return req;
    },
  };
}

const readOne = () =>
  withStore('files', 'readonly', (tx) => {
    tx.objectStore('files');
    return Promise.resolve('ok');
  });

test('连接复用：连续读写只开一次库，别标签页改版本才作废重开', async () => {
  installFakeIndexedDb();

  assert.equal(await readOne(), 'ok');
  assert.equal(await readOne(), 'ok');
  await withStore(['files', 'thumbs'], 'readwrite', (tx) => {
    tx.objectStore('files');
    return Promise.resolve();
  });
  assert.equal(state.opens, 1, '三次操作只该开一次库');
  assert.equal(state.closes, 0, '谁都不该在操作结束时关这条共享连接');
  assert.deepEqual(state.transactions, ['files=readonly', 'files=readonly', 'files+thumbs=readwrite']);

  // 另一个标签页升级/删除库：这条连接作废，下一次调用重开
  state.lastDb.onversionchange();
  assert.equal(state.closes, 1, '失效时主动关掉，别占着版本升级');
  assert.equal(await readOne(), 'ok');
  assert.equal(state.opens, 2, '失效后必须重开一条');

  // 开库失败的 promise 不能留在缓存上，否则整个页面生命周期只重试同一个错误
  state.lastDb.onversionchange();
  state.failOpen = true;
  await assert.rejects(readOne(), /开库失败/);
  assert.equal(state.attempts, 3, '缓存失效后确实又试了一次开库');
  state.failOpen = false;
  assert.equal(await readOne(), 'ok');
  assert.equal(state.opens, 3, '失败过的下一次调用要能重开成功');

  // 没有 indexedDB 的环境（隐私模式/老浏览器）走明确错误，不是崩溃
  state.lastDb.onversionchange();
  delete globalThis.indexedDB;
  await assert.rejects(openLocalDb(), /不支持本地素材库/);
});

test('变化通知按 key 分发：删一张图只刷正在看它的格子', () => {
  const fired = [];
  const spy = (name) => () => fired.push(name);
  const cleanups = [];
  const watch = (key, name) => cleanups.push(subscribeLocalStore(key, spy(name)));

  watch('key-a', 'a1');
  const a2 = subscribeLocalStore('key-a', spy('a2'));
  watch('key-b', 'b1');

  notifyLocalStore('key-a');
  assert.deepEqual(fired, ['a1', 'a2'], '只有 key-a 的监听者被叫醒，key-b 不该重读');

  fired.length = 0;
  a2();
  notifyLocalStore('key-a');
  assert.deepEqual(fired, ['a1'], '退订之后不再收到');

  fired.length = 0;
  notifyLocalStore('thumb:key-a');
  assert.deepEqual(fired, [], '预览图槽位和原图槽位互不串台');

  // 通知途中退订，不该让排在后面的监听者被跳过
  let offKiller = () => {};
  const killer = subscribeLocalStore('key-c', () => {
    fired.push('killer');
    offKiller();
  });
  offKiller = killer;
  watch('key-c', 'tail');
  fired.length = 0;
  notifyLocalStore('key-c');
  assert.deepEqual(fired, ['killer', 'tail'], '遍历用的是快照');

  fired.length = 0;
  for (const off of cleanups) off();
  notifyLocalStore('key-c');
  notifyLocalStore('没人听过的 key');
  assert.deepEqual(fired, [], '全部退订后通知变成空操作，也不该抛错');
});
