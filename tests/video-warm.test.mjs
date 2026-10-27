import test from 'node:test';
import assert from 'node:assert/strict';

import { holdVideo, warmVideo } from '../src/lib/video-warm.ts';

/**
 * 预热池的两条命门，用假 DOM 才断言得动：
 * 1. 一个地址要么在屏幕上（被层 hold 住），要么在池里，**不会同时两处** ——
 *    否则同一支视频的头部被拉两遍，用户多花的正是省下来想省的那份流量。
 * 2. 池子有上限，淘汰的是最久没被用到的那条，而且淘汰时真的把 src 摘掉（不摘就还在下载）。
 *
 * 至于「热到的字节够不够首帧立刻出来」，假 DOM 答不了，那一段由浏览器实测补。
 * 池子是模块级的，一次进程只清不回来，所以每个用例用各自不重样的地址，断言按成员不按全集。
 */

const created = [];

class FakeVideo {
  constructor() {
    this.dataset = {};
    this.style = { cssText: '' };
    this.listeners = {};
    this.removed = false;
    this.srcCleared = false;
    this.loadedCalls = 0;
    created.push(this);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  removeAttribute(name) {
    if (name === 'src') this.srcCleared = true;
  }
  load() {
    this.loadedCalls += 1;
  }
  remove() {
    this.removed = true;
  }
  get url() {
    return this.dataset.warmUrl;
  }
}

globalThis.document = {
  body: { appendChild() {} },
  createElement: (tag) =>
    tag === 'video'
      ? new FakeVideo()
      : { id: '', setAttribute() {}, style: { cssText: '' }, appendChild() {} },
};

const pool = () => created.filter((v) => !v.removed);
const has = (url) => pool().some((v) => v.url === url);
const at = (n) => `https://cdn.test/warm-${n}.mp4`;

test('预热一条不在屏幕上的片源：只挂一个不动的元素，且不 play', () => {
  const url = at('single');
  warmVideo(url);
  assert.ok(has(url), '地址要认得出来，不然探针没法数池子');
  const el = pool().find((v) => v.url === url);
  assert.equal(el.preload, 'metadata', 'preload="auto" 等于替用户下载一百多兆的 4K');
  assert.equal(el.muted, true);
  assert.equal(el.src, url);
});

test('同一地址重复预热只留一条：来回翻页不会把池子灌满副本', () => {
  const url = at('dup');
  warmVideo(url);
  const count = pool().length;
  warmVideo(url);
  assert.equal(pool().length, count, `多挂了一条（${count} → ${pool().length}）`);
});

test('hold 住的那条从池里让位，松手时再交还 —— 一处地址永远只有一个主人', () => {
  const url = at('handoff');
  warmVideo(url);
  assert.ok(has(url));
  const release = holdVideo(url);
  assert.ok(!has(url), '屏幕上的那条已经在自己拉字节了，池里再挂一条就是拉两遍');
  const dropped = created.find((v) => v.url === url && v.removed);
  assert.ok(dropped.srcCleared && dropped.loadedCalls > 0, '让位要连 src 一起摘掉：只 remove 元素，range 请求不会停');
  release();
  assert.ok(has(url), '翻走之后把字节留在会话里：翻回来不该从探测 moov 重跑');
});

test('屏幕上有人在放这条时，预热不另开一份', () => {
  const url = at('live');
  const release = holdVideo(url);
  warmVideo(url);
  assert.ok(!has(url), '这一条的字节由屏幕上那层自己拉');
  release();
  assert.ok(has(url));
});

test('超过上限只留最近用到的三条，淘汰按新旧而不是按地址顺序', () => {
  const urls = ['1', '2', '3', '4', '5'].map((n) => `https://cdn.test/cap-${n}.mp4`);
  for (const url of urls) warmVideo(url);
  const kept = pool().map((v) => v.url);
  assert.equal(kept.length, 3, `池里留了 ${kept.length} 条`);
  assert.ok(!kept.includes(urls[0]), '最先用到的该走');
  assert.deepEqual(new Set(kept.slice(-3)), new Set(urls.slice(2)), '留下的是最近那三条');
});

test('本机素材（blob:）和非法地址一个元素都不造：池子只管走网络的那些', () => {
  const before = pool().length;
  for (const bad of ['blob:https://app/1234', 'data:video/mp4,AAAA', 'http://insecure.test/x.mp4', '//evil.test/x.mp4', '']) {
    warmVideo(bad);
  }
  assert.equal(pool().length, before, '本机素材在硬盘上，预热它只是白读一遍库');
});

test('两层同时放同一条时，只有一层松手不交还给池；同一个松手函数叫两次也只减一次', () => {
  const url = at('shared');
  const first = holdVideo(url);
  const second = holdVideo(url);
  first();
  first();
  assert.ok(!has(url), '还有一层在放它，不该被当成没人要');
  second();
  assert.ok(has(url));
});
