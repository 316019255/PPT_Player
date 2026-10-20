/**
 * 后台 PPT 页的纯逻辑，单独一个文件、不碰 db / pg：
 * 视图（'use client'）要 import 这里的常量和判断函数，
 * 从 admin-data 拖进来就等于把整个 pg 打进浏览器包。（同 ./admin-users 的理由）
 */

/** 一页 30 行；后台一次看 30 份稿子足够，再多就是白付的跨海字节 */
export const DECK_PAGE_SIZE = 30;

export interface AdminDeckRow {
  id: number;
  title: string;
  user_id: number;
  email: string;
  name: string;
  /** 作者是游客（免登录那批），由 SQL 算出来，见 admin-sql 的 guestIs() */
  is_guest: boolean;
  category_id: number | null;
  category_name: string | null;
  slides: number;
  bytes: number;
  created_at: string;
  updated_at: string;
}

export interface DeckPage {
  rows: AdminDeckRow[];
  total: number;
}

export interface DeckCategoryOption {
  id: number;
  name: string;
}

export type DeckCategoryFilter = 'all' | 'none' | number;

/**
 * 地址栏里的分类筛选只认三种：不填或认不出来 = 全部、'none' = 未分类、正整数 = 那个分类。
 * 非法值退回默认而不是 500 —— 手改一个 categoryId=abc 不该让页面挂掉。
 */
export function parseDeckCategory(raw: string | number | null | undefined): DeckCategoryFilter {
  if (raw === 'none') return 'none';
  const id = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(id) && id > 0 ? id : 'all';
}

/** 按作者筛：0、负数、NaN 都算「不筛」。null 是默认值，不用前端传空字符串 */
export function parseDeckUserId(raw: string | number | null | undefined): number | null {
  const id = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * 大小那一列报的是 UTF-8 字节数，和存盘时那条 2MB 上限（slide-data.MAX_DATA_BYTES
 * 用 Buffer.byteLength 比）同一个口径。用字符数就不对得上：一页中文歌词
 * 一个字算 1 个字符、3 个字节，管理员看到的「才 700K」实际已经快撑爆。
 */
export function formatBytes(value: number): string {
  const n = Number.isFinite(value) && value > 0 ? value : 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** 列表和手机卡片共用这一句「多少页 · 多大」，两处各写一遍迟早会不一样 */
export function deckGist(row: Pick<AdminDeckRow, 'slides' | 'bytes'>): string {
  return `${row.slides} 页 · ${formatBytes(row.bytes)}`;
}
