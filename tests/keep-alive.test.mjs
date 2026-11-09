import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 保活这件事的两个失效方式，都长得像「一切正常」，所以在这里钉成门禁：
 *   ① 探针路由被预渲染成静态文件 → 每次打的都是缓存，一条 SQL 都不碰；
 *   ② 定时被改成 7 天以上 → 正好落在 Supabase 的暂停阈值上，等于没保活。
 * 这里证明的是「码写对了」；线上真的通不通，看 Actions 那次跑的记录（README 上公网前的清单第 9 条）。
 */

const root = join(import.meta.dirname, '..');
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');

const route = read('src', 'app', 'api', 'health', 'route.ts');
const workflow = read('.github', 'workflows', 'keep-alive.yml');

test('探针不能被预渲染：force-dynamic 必须在，且响应必须 no-store', () => {
  assert.match(route, /export const dynamic = 'force-dynamic'/, '少了 force-dynamic：GET 处理器会被预渲染，保活变成打缓存');
  assert.match(route, /'cache-control': 'no-store'/, '少了 no-store：中间层可能把响应缓存下来');
});

test('探针只读、不建档、不外泄数据库报错', () => {
  assert.match(route, /SELECT/, '探针得真跑一条查询，否则不算项目活动');
  assert.doesNotMatch(route, /\bINSERT\b|\bUPDATE\b|\bDELETE\b/, '探针写库就是在攒垃圾数据');
  // 走 getCurrentUserOrGuest 那类 helper 会替每个匿名访客 INSERT 一行 users：
  // 每两天攒一行，一年下来库里多出一百八十来条没人认领的游客档。
  assert.doesNotMatch(route, /getCurrentUserOrGuest|getOrCreateGuest/, '探针不许为匿名请求建档');
  assert.doesNotMatch(route, /json\(\{[^}]*\berror\b/, 'pg 的报错原文会带主机名和用户名，只能进日志');
});

/**
 * 只认两种写法，认不出来就判失败 —— 猜错 cron 的间隔比报错危险得多。
 * 返回「最坏情况下两次运行之间隔几天」。
 */
function worstGapDays(cron) {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, , dom, mon, dow] = fields;
  if (mon !== '*' || minute === '*') return null;

  const everyNdays = /^\*\/(\d+)$/.exec(dom);
  if (dow === '*' && everyNdays) return Number(everyNdays[1]);

  if (dom === '*' && /^\d+(?:,\d+)*$/.test(dow)) {
    const days = dow.split(',').map(Number).sort((a, b) => a - b);
    if (days.some((d) => d < 0 || d > 6)) return null;
    let worst = days[0] + 7 - days.at(-1); // 跨周末那一段
    for (let i = 1; i < days.length; i += 1) worst = Math.max(worst, days[i] - days[i - 1]);
    return worst;
  }
  return null;
}

test('定时任务的间隔必须留得住缓冲（最坏 ≤ 4 天，暂停阈值是 7 天）', () => {
  const crons = [...workflow.matchAll(/-\s*cron:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(crons.length >= 1, 'keep-alive.yml 里没有 schedule cron，等于不会自己跑');

  const gaps = crons.map(worstGapDays);
  gaps.forEach((gap, i) => {
    assert.ok(gap !== null, `第 ${i + 1} 条 cron「${crons[i]}」的写法这里判不出间隔，请手动确认最坏间隔 < 7 天再改成能判的写法`);
    assert.ok(gap <= 4, `第 ${i + 1} 条 cron「${crons[i]}」最坏隔 ${gap} 天，太贴近 7 天的暂停阈值`);
  });

  assert.match(workflow, /workflow_dispatch:/, '要留一个手动 Run 的入口：GitHub 会在仓库 60 天无活动时自动禁用定时');
});

test('定时打的地址和路由自己对得上，而且打的不是本机', () => {
  const urls = [...workflow.matchAll(/https?:\/\/[^\s'"]+/g)].map((m) => m[0]);
  assert.ok(urls.length >= 1, 'keep-alive.yml 里没找到要打的 URL');
  for (const url of urls) {
    assert.match(url, /^https:\/\//, `保活要打线上站点，收到 ${url}`);
    assert.doesNotMatch(url, /localhost|127\.0\.0\.1/, '打本机的话，GitHub 的 runner 根本连不到数据库');
    assert.match(url, /\/api\/health\/?$/, `URL 和 src/app/api/health 对不上：${url}`);
  }
});
