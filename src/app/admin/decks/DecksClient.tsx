'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  DECK_PAGE_SIZE,
  deckGist,
  type AdminDeckRow,
  type DeckCategoryOption,
} from '@/lib/admin-decks';
import NoticeBar, { type Notice } from '@/components/NoticeBar';
import RowMenu from '@/components/RowMenu';
import { ConfirmKey } from '@/components/PhoneDock';

interface Query {
  /** 只看某一位作者（从行菜单进来），null = 不限 */
  userId: number | null;
  categoryId: 'all' | 'none' | number;
  q: string;
  page: number;
}

export default function DecksClient({
  initialDecks,
  initialTotal,
}: {
  initialDecks: AdminDeckRow[];
  initialTotal: number;
}) {
  const router = useRouter();
  const [decks, setDecks] = useState(initialDecks);
  const [total, setTotal] = useState(initialTotal);
  const [query, setQuery] = useState<Query>({ userId: null, categoryId: 'all', q: '', page: 1 });
  const [search, setSearch] = useState('');
  const [author, setAuthor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const [renaming, setRenaming] = useState<AdminDeckRow | null>(null);
  const [titleInput, setTitleInput] = useState('');
  const [moving, setMoving] = useState<AdminDeckRow | null>(null);
  const [moveCategories, setMoveCategories] = useState<DeckCategoryOption[]>([]);
  const [moveLoading, setMoveLoading] = useState(false);
  const moveSeq = useRef(0);
  const [moveTarget, setMoveTarget] = useState<string>('none');
  const [deleting, setDeleting] = useState<AdminDeckRow | null>(null);
  /** 只看某一位作者时，分类下拉才列得出他自己的目录（跨作者的分类混在一起没法选） */
  const [filterCategories, setFilterCategories] = useState<DeckCategoryOption[]>([]);

  const pages = Math.max(1, Math.ceil(total / DECK_PAGE_SIZE));

  async function load(next: Query) {
    setBusy(true);
    try {
      const params = new URLSearchParams({ page: String(next.page) });
      if (next.userId) params.set('userId', String(next.userId));
      if (next.categoryId !== 'all') params.set('categoryId', String(next.categoryId));
      if (next.q) params.set('q', next.q);
      const res = await fetch(`/api/admin/decks?${params}`);
      if (!res.ok) {
        await reportFailure(res, '列表刷新失败');
        return;
      }
      const data = await res.json();
      setQuery(next);
      setDecks(data.decks || []);
      setTotal(data.total || 0);
    } finally {
      setBusy(false);
    }
  }

  /** 接口已经把原因写成中文了，直接播出去；没有才补一句兜底的 */
  async function reportFailure(res: Response, fallback: string) {
    let text = fallback;
    try {
      const data = await res.json();
      if (typeof data?.error === 'string') text = data.error;
    } catch {
      /* 非 JSON 的错误页（网关、构建期 500）就走兜底文案 */
    }
    setNotice({ tone: 'error', text });
  }

  /** 改名 / 移分类：接口回读的是被改的那几列，作者信息和 created_at 原地留着 */
  async function applyPatch(
    row: AdminDeckRow,
    patch: Record<string, unknown>
  ): Promise<AdminDeckRow | null> {
    const res = await fetch(`/api/admin/decks/${row.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      await reportFailure(res, '操作失败');
      return null;
    }
    const data = await res.json();
    const merged = { ...row, ...data.deck } as AdminDeckRow;
    setDecks((prev) => prev.map((d) => (d.id === row.id ? merged : d)));
    return merged;
  }

  const submitRename = async () => {
    if (!renaming) return;
    const merged = await applyPatch(renaming, { title: titleInput });
    if (merged) {
      setNotice({ tone: 'ok', text: `已改名为《${merged.title}》 · 用户侧同步生效` });
      setRenaming(null);
    }
  };

  async function fetchCategories(userId: number): Promise<DeckCategoryOption[]> {
    const res = await fetch(`/api/admin/categories?userId=${userId}`);
    if (!res.ok) {
      await reportFailure(res, '分类读不出来');
      return [];
    }
    const data = await res.json();
    return (data.categories || []) as DeckCategoryOption[];
  }

  const openMove = async (row: AdminDeckRow) => {
    const seq = ++moveSeq.current;
    setMoving(row);
    // 候选必须是这位作者的分类，不是管理员自己的
    setMoveCategories([]);
    setMoveTarget(row.category_id === null ? 'none' : String(row.category_id));
    setMoveLoading(true);
    const cats = await fetchCategories(row.user_id);
    // 已经换到另一份稿子的弹窗了：这次结果过期，别写进去
    if (moveSeq.current !== seq) return;
    setMoveCategories(cats);
    setMoveLoading(false);
  };

  const submitMove = async () => {
    if (!moving) return;
    const value = moveTarget === 'none' ? null : Number(moveTarget);
    const merged = await applyPatch(moving, { category_id: value });
    if (merged) {
      setNotice({ tone: 'ok', text: `已移到「${merged.category_name || '未分类'}」` });
      setMoving(null);
    }
  };

  const submitDelete = async (row: AdminDeckRow) => {
    const res = await fetch(`/api/admin/decks/${row.id}`, { method: 'DELETE' });
    if (!res.ok) {
      await reportFailure(res, '删除失败');
      return;
    }
    const data = await res.json();
    setDecks((prev) => prev.filter((d) => d.id !== row.id));
    setTotal((t) => Math.max(0, t - 1));
    setNotice({
      tone: 'ok',
      text: `已删除《${data.deleted?.title ?? row.title}》（作者 ${data.deleted?.email ?? row.email}）· 只删了这一行，云端桶里的素材文件没动`,
    });
  };

  const onlyAuthor = async (row: AdminDeckRow) => {
    setAuthor(`${row.name}·${row.email}`);
    // 换作者就是把分类筛选清空：上一位的分类对这一位毫无意义
    setFilterCategories(await fetchCategories(row.user_id));
    await load({ userId: row.user_id, categoryId: 'all', q: query.q, page: 1 });
  };

  const clearAuthor = async () => {
    setAuthor(null);
    setFilterCategories([]);
    await load({ ...query, userId: null, categoryId: 'all', page: 1 });
  };

  const rowMenu = (d: AdminDeckRow) => (
    <RowMenu
      width={190}
      items={[
        { kind: 'label', label: d.title },
        { kind: 'action', label: '👁 只读预览', onClick: () => router.push(`/admin/decks/${d.id}`) },
        { kind: 'action', label: '只看这位作者', onClick: () => void onlyAuthor(d) },
        { kind: 'divider' },
        {
          kind: 'action',
          label: '改名…',
          onClick: () => {
            setTitleInput(d.title);
            setRenaming(d);
          },
        },
        { kind: 'action', label: '移分类…', onClick: () => void openMove(d) },
        { kind: 'divider' },
        { kind: 'action', label: '删除…', tone: 'danger', onClick: () => setDeleting(d) },
      ]}
    />
  );

  const cells = (d: AdminDeckRow) => (
    <>
      <div className="min-w-0">
        <div className="truncate text-sm" title={d.title}>
          {d.title}
        </div>
        <div className="text-xs text-gray-400 mt-1 break-all">
          #{d.id} · {d.name}·{d.email}
          {d.is_guest && <span className="text-gray-500"> · 游客</span>}
        </div>
        <div className="text-xs text-gray-400">
          {deckGist(d)} · 更新 {d.updated_at.slice(0, 10)}
        </div>
      </div>
      {rowMenu(d)}
    </>
  );

  return (
    <div className="min-h-dvh bg-[#0f0f14] text-[#e0e0e0]">
      <header className="px-6 py-4 flex items-center justify-between border-b border-white/10">
        <div className="flex items-center gap-4">
          <Link href="/admin" className="text-gray-400 hover:text-white">← 返回</Link>
          <div className="text-xl font-bold">PPT 管理</div>
        </div>
      </header>

      <div className="p-6">
        {notice && <NoticeBar notice={notice} onClose={() => setNotice(null)} />}

        <div className="mb-6 flex flex-wrap items-center gap-3">
          <select
            value={String(query.categoryId)}
            onChange={(e) =>
              void load({
                ...query,
                categoryId: e.target.value === 'all' || e.target.value === 'none'
                  ? (e.target.value as 'all' | 'none')
                  : Number(e.target.value),
                page: 1,
              })
            }
            className="px-3 py-2 rounded-lg bg-white/10 border border-white/20 text-sm"
          >
            <option value="all">全部分类</option>
            <option value="none">未分类</option>
            {filterCategories.map((c) => (
              <option key={c.id} value={String(c.id)}>
                {c.name}
              </option>
            ))}
          </select>

          {/* 搜索：回车或点按钮才查，不在每次按键上打一趟东京 */}
          <form
            className="flex gap-2 flex-1 min-w-[220px]"
            onSubmit={(e) => {
              e.preventDefault();
              void load({ ...query, q: search.trim(), page: 1 });
            }}
          >
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索标题、作者邮箱或姓名..."
              className="flex-1 max-w-md px-4 py-2 rounded-lg bg-white/10 border border-white/20 text-sm"
            />
            <button
              type="submit"
              className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 transition text-sm"
            >
              搜索
            </button>
          </form>

          {query.userId !== null && (
            <button
              onClick={() => void clearAuthor()}
              className="px-3 py-1.5 rounded-lg bg-blue-600/30 border border-blue-400/40 text-xs text-blue-200 hover:bg-blue-600/50 transition"
              title="取消按作者筛选"
            >
              作者：{author ?? query.userId} ✕
            </button>
          )}

          <span className="text-xs text-gray-500">
            共 {total} 份 · 第 {query.page}/{pages} 页
            {busy && ' · 刷新中…'}
          </span>
        </div>

        {decks.length === 0 ? (
          <div className="text-center py-20 text-gray-500">
            <div className="text-5xl mb-4">📑</div>
            <p>这一档里还没有稿子</p>
            <p className="text-xs mt-2">换个筛选条件，或者搜个标题 / 邮箱试试。</p>
          </div>
        ) : (
          <>
            {/* 桌面表格 */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-gray-400">
                    <th className="text-left py-3 px-4">ID</th>
                    <th className="text-left py-3 px-4">标题</th>
                    <th className="text-left py-3 px-4">作者</th>
                    <th className="text-left py-3 px-4">分类</th>
                    <th className="text-left py-3 px-4">页数 / 大小</th>
                    <th className="text-left py-3 px-4">更新</th>
                    <th className="text-left py-3 px-4">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {decks.map((d) => (
                    <tr key={d.id} className="border-b border-white/5 hover:bg-white/5">
                      <td className="py-3 px-4 text-gray-500">{d.id}</td>
                      <td className="py-3 px-4 max-w-[300px]">
                        <div className="truncate" title={d.title}>
                          {d.title}
                        </div>
                      </td>
                      <td className="py-3 px-4 break-all">
                        {d.email}
                        {d.is_guest && <span className="text-gray-500 text-xs"> · 游客</span>}
                      </td>
                      <td className="py-3 px-4">
                        {d.category_name ?? <span className="text-gray-500">未分类</span>}
                      </td>
                      <td className="py-3 px-4 text-gray-300 whitespace-nowrap">{deckGist(d)}</td>
                      <td className="py-3 px-4 text-gray-400 whitespace-nowrap">
                        {d.updated_at.slice(0, 10)}
                      </td>
                      <td className="py-3 px-4">{rowMenu(d)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* 手机端卡片：七列压成横滚表格在手机上没法读，也没法按 */}
            <div className="md:hidden space-y-3">
              {decks.map((d) => (
                <div key={d.id} className="rounded-lg border border-white/10 bg-white/5 p-3 flex items-start justify-between gap-2">
                  {cells(d)}
                </div>
              ))}
            </div>
          </>
        )}

        {/* 分页 */}
        {total > DECK_PAGE_SIZE && (
          <div className="mt-6 flex items-center gap-3">
            <button
              onClick={() => void load({ ...query, page: query.page - 1 })}
              disabled={busy || query.page <= 1}
              className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 transition text-sm disabled:opacity-40"
            >
              ← 上一页
            </button>
            <span className="text-xs text-gray-500">
              第 {query.page} / {pages} 页 · 每页 {DECK_PAGE_SIZE} 份
            </span>
            <button
              onClick={() => void load({ ...query, page: query.page + 1 })}
              disabled={busy || query.page >= pages}
              className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 transition text-sm disabled:opacity-40"
            >
              下一页 →
            </button>
          </div>
        )}
      </div>

      {/* 改名 */}
      {renaming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="bg-[#1a1a24] rounded-xl p-6 max-w-md w-full border border-white/10">
            <h2 className="text-lg font-semibold mb-1">改标题</h2>
            <div className="text-xs text-gray-400 mb-4 break-all">
              #{renaming.id} · {renaming.email}
            </div>

            <label className="text-xs text-gray-400">标题（最长 100 字，留空回「未命名演示文稿」）</label>
            <input
              type="text"
              value={titleInput}
              onChange={(e) => setTitleInput(e.target.value)}
              className="w-full mt-1 px-3 py-2 rounded-lg bg-white/10 border border-white/20 text-sm"
            />

            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setRenaming(null)}
                className="flex-1 py-2 rounded-lg bg-white/10 hover:bg-white/20 transition text-sm"
              >
                取消
              </button>
              <button
                onClick={() => void submitRename()}
                className="flex-1 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 transition text-sm font-semibold"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 移分类：候选只列这份稿子作者自己的分类 */}
      {moving && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="bg-[#1a1a24] rounded-xl p-6 max-w-md w-full border border-white/10">
            <h2 className="text-lg font-semibold mb-1">移到哪个分类</h2>
            <div className="text-xs text-gray-400 mb-4 break-all">
              《{moving.title}》 · {moving.email}
            </div>

            <select
              value={moveTarget}
              onChange={(e) => setMoveTarget(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-white/10 border border-white/20 text-sm"
            >
              <option value="none">未分类</option>
              {moveCategories.map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {c.name}
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-500 mt-2">
              {moveLoading
                ? '分类加载中… —— 得先确认这是这位作者自己的目录，候选没读回来之前不让你保存。'
                : `这里只列 ${moving.email} 自己建的分类 —— 分类是各人的私有目录， 挂错了人前台就会看到一个他没建过的文件夹。`}
            </p>

            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setMoving(null)}
                className="flex-1 py-2 rounded-lg bg-white/10 hover:bg-white/20 transition text-sm"
              >
                取消
              </button>
              <button
                onClick={() => void submitMove()}
                disabled={moveLoading}
                className="flex-1 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 transition text-sm font-semibold disabled:opacity-40"
              >
                {moveLoading ? '分类加载中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除：按两下才动手，确认框里说清删掉的是谁的哪一叠 */}
      {deleting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="bg-[#1a1a24] rounded-xl p-6 max-w-md w-full border border-white/10">
            <h2 className="text-lg font-semibold mb-1">删掉这份演示文稿？</h2>
            <div className="text-sm mb-1">《{deleting.title}》</div>
            <div className="text-xs text-gray-400 mb-4 break-all">
              #{deleting.id} · {deleting.name}·{deleting.email} · {deckGist(deleting)}
            </div>

            <p className="text-sm leading-relaxed">
              只删这一份稿子，那个账号和它的其它稿子都不动。
              稿子里用到的云端素材文件保留（可能被别的稿子共用）。
            </p>

            <div className="flex gap-3 mt-6 items-stretch">
              <button
                onClick={() => setDeleting(null)}
                className="flex-1 py-2 rounded-lg bg-white/10 hover:bg-white/20 transition text-sm"
              >
                取消
              </button>
              <ConfirmKey
                label="删除"
                confirmLabel="再点一次就删除"
                onConfirm={async () => {
                  const row = deleting;
                  setDeleting(null);
                  await submitDelete(row);
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
