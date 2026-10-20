import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DECK_PAGE_SIZE,
  deckGist,
  formatBytes,
  parseDeckCategory,
  parseDeckUserId,
} from '../src/lib/admin-decks.ts';
import {
  DECK_TITLE_FALLBACK,
  DECK_TITLE_MAX,
  normalizeDeckTitle,
} from '../src/lib/deck-title.ts';

/**
 * 标题这一条规则三个入口共用（新建 / 用户改名 / 后台改名），
 * 断言的是「和用户侧原来那两行内联写法逐字等价」，不是新行为。
 */
test('标题：先去空白、空了兜底，再截长度', () => {
  assert.equal(normalizeDeckTitle('  歌词本  '), '歌词本');
  assert.equal(normalizeDeckTitle('   '), DECK_TITLE_FALLBACK);
  assert.equal(normalizeDeckTitle(''), DECK_TITLE_FALLBACK);
  // 新建接口以前就允许 title 缺省 / 是数字，兜底同一条路
  assert.equal(normalizeDeckTitle(undefined), DECK_TITLE_FALLBACK);
  assert.equal(normalizeDeckTitle(42), DECK_TITLE_FALLBACK);
  assert.equal(normalizeDeckTitle('a'.repeat(DECK_TITLE_MAX + 50)), 'a'.repeat(DECK_TITLE_MAX));
});

test('一页 30 行是接口和分页控件共用的那个数', () => {
  assert.equal(DECK_PAGE_SIZE, 30);
});

test('分类筛选只认 all / none / 正整数，其余退回全部', () => {
  assert.equal(parseDeckCategory(null), 'all');
  assert.equal(parseDeckCategory(undefined), 'all');
  assert.equal(parseDeckCategory(''), 'all');
  assert.equal(parseDeckCategory('abc'), 'all');
  assert.equal(parseDeckCategory('0'), 'all');
  assert.equal(parseDeckCategory('-3'), 'all');
  assert.equal(parseDeckCategory('1.5'), 'all');
  assert.equal(parseDeckCategory('none'), 'none');
  assert.equal(parseDeckCategory('7'), 7);
  assert.equal(parseDeckCategory(7), 7);
});

test('作者筛选：非法 id 等于不筛，而不是筛出空列表', () => {
  assert.equal(parseDeckUserId(null), null);
  assert.equal(parseDeckUserId(''), null);
  assert.equal(parseDeckUserId('abc'), null);
  assert.equal(parseDeckUserId('0'), null);
  assert.equal(parseDeckUserId('-1'), null);
  assert.equal(parseDeckUserId('89'), 89);
});

/**
 * 大小列必须报字节数：存盘那条 2MB 上限是 Buffer.byteLength 算的。
 * 汉字 1 个字符 = 3 个字节，报字符数会让管理员看到的数比真实占用小三倍。
 */
test('字节数按 B / KB / MB 三档报，0 和坏值不炸', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1024 * 1024), '1.00 MB');
  assert.equal(formatBytes(2 * 1024 * 1024), '2.00 MB');
  assert.equal(formatBytes(-5), '0 B');
  assert.equal(formatBytes(Number.NaN), '0 B');
});

test('列表和手机卡片用的是同一句「几页 · 多大」', () => {
  assert.equal(deckGist({ slides: 31, bytes: 160 * 1024 }), '31 页 · 160.0 KB');
});
