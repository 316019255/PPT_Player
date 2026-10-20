'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import RowMenu, { type RowMenuItem } from '@/components/RowMenu';
import NoticeBar, { type Notice } from '@/components/NoticeBar';
import { ConfirmKey } from '@/components/PhoneDock';
import SheetOverlay from '@/components/SheetOverlay';
import { SheetHint } from '@/components/PhoneUi';
import { useCompactEditor } from '@/components/useCompactEditor';
import { useKeyboardInset } from '@/components/usePhoneViewport';
import { loadPptxPipeline, runPptxImport } from '@/app/dashboard/importRunner';
import { hasMediaBase } from '@/lib/media-source';
import { FREE_PPT_LIMIT } from '@/types/ppt';
import { usePptStore } from '@/store/pptStore';

interface PresentationItem {
  id: number;
  title: string;
  category_id: number | null;
  category_name: string | null;
  created_at: string;
  updated_at: string;
  slide_count: number;
}

interface CategoryItem {
  id: number;
  name: string;
  ppt_count: number;
}

interface Props {
  initialPresentations: PresentationItem[];
  initialCategories: CategoryItem[];
  initialPro: boolean;
  initialTotalCount: number;
  quotaNotice?: boolean;
  isGuest?: boolean;
  /** 服务端算好的「这个账号在管理员名单里」；false 时后台入口整颗不渲染 */
  initialIsAdmin?: boolean;
}

/** 手机端筛选 chip：44px 高、带计数，点哪个就只看那个分类 */
function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 h-11 px-3 rounded-lg text-sm whitespace-nowrap transition ${
        active ? 'bg-blue-600 text-white' : 'bg-white/10 text-gray-300 active:bg-white/25'
      }`}
    >
      {label}
    </button>
  );
}

async function errorOf(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  return data?.error || fallback;
}

export default function DashboardClient({
  initialPresentations,
  initialCategories,
  initialPro,
  initialTotalCount,
  quotaNotice,
  isGuest,
  initialIsAdmin: isAdmin,
}: Props) {
  const router = useRouter();
  const setImportNotice = usePptStore((s) => s.setImportNotice);
  const compact = useCompactEditor();
  const keyboardInset = useKeyboardInset();
  const [presentations, setPresentations] = useState(initialPresentations);
  const [pro, setPro] = useState(initialPro);
  const [totalCount, setTotalCount] = useState(initialTotalCount);
  // 配额提示是一个「状态」而不是一条消息：新建被本地拦下和服务端 ?quota=1 打回来是同一件事，
  // 两条都走它才不会让提示条叠成两层。
  const [quota, setQuota] = useState(quotaNotice ?? false);
  const [notice, setNotice] = useState<Notice | null>(null);
  // 手机端把侧栏那套收进两个抽屉窗，桌面端用不到
  const [sheet, setSheet] = useState<'cats' | 'account' | null>(null);
  const [categories, setCategories] = useState(initialCategories);
  const [activeCat, setActiveCat] = useState<number | 'all' | 'null'>('all');
  const [deleting, setDeleting] = useState<number | null>(null);
  const [newCatName, setNewCatName] = useState('');
  const [showNewCat, setShowNewCat] = useState(false);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [importLabel, setImportLabel] = useState('');
  const [importCloud, setImportCloud] = useState(true);
  const [loggingOut, setLoggingOut] = useState(false);
  // 云端公开读没配：传上去也画不出来，所以勾选框直接禁掉并写明原因，不给一个按下去没反应的选项
  const cloudReady = hasMediaBase();

  // 分类增删改后刷新计数（首屏由服务端直接给出）
  const loadCategories = async () => {
    try {
      const res = await fetch('/api/categories', { cache: 'no-store' });
      const data = (await res.json()) as { categories?: CategoryItem[] };
      setCategories(data.categories ?? []);
    } catch {
      // 分类是辅助信息，加载失败保持当前列表即可
    }
  };

  // 加分类
  const handleAddCategory = async () => {
    const name = newCatName.trim();
    if (!name) return;
    const res = await fetch('/api/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (res.ok) {
      setNewCatName('');
      setShowNewCat(false);
      void loadCategories();
    } else {
      setNotice({ tone: 'error', text: await errorOf(res, '创建失败') });
    }
  };

  /**
   * 确认属于 UI，不属于删除逻辑：手机端由两次点击的 ConfirmKey 负责，
   * 桌面端那个 ⋯ 弹层里塞不进常驻的二次确认，所以在这儿用原生对话框。
   */
  const askDeleteCategory = (cat: CategoryItem) => {
    const impact =
      cat.ppt_count > 0
        ? `该分类下的 ${cat.ppt_count} 个 PPT 会变成未分类（内容不会被删除）。`
        : '';
    if (confirm(`删除分类「${cat.name}」？${impact}`)) void handleDeleteCategory(cat);
  };

  const handleDeleteCategory = async (cat: CategoryItem) => {
    const res = await fetch(`/api/categories/${cat.id}`, { method: 'DELETE' });
    if (!res.ok) {
      setNotice({ tone: 'error', text: await errorOf(res, '删除失败') });
      return;
    }
    setPresentations((prev) =>
      prev.map((p) =>
        p.category_id === cat.id ? { ...p, category_id: null, category_name: null } : p
      )
    );
    void loadCategories();
    if (activeCat === cat.id) setActiveCat('all');
  };

  const startRename = (cat: CategoryItem) => {
    setRenamingId(cat.id);
    setRenameValue(cat.name);
  };

  const handleRenameConfirm = async () => {
    if (renamingId === null) return;
    const id = renamingId;
    setRenamingId(null);
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === categories.find((c) => c.id === id)?.name) return;

    const res = await fetch(`/api/categories/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmed }),
    });
    if (res.ok) {
      setPresentations((prev) =>
        prev.map((p) => (p.category_id === id ? { ...p, category_name: trimmed } : p))
      );
      void loadCategories();
    } else setNotice({ tone: 'error', text: await errorOf(res, '重命名失败') });
  };

  const handleMove = async (id: number, categoryId: number | null) => {
    const res = await fetch(`/api/presentations/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category_id: categoryId }),
    });
    if (!res.ok) {
      setNotice({ tone: 'error', text: await errorOf(res, '移动失败') });
      return;
    }
    setPresentations((prev) =>
      prev.map((p) =>
        p.id === id
          ? {
              ...p,
              category_id: categoryId,
              category_name: categories.find((c) => c.id === categoryId)?.name ?? null,
            }
          : p
      )
    );
    void loadCategories();
  };

  const cardMenuItems = (p: PresentationItem): RowMenuItem[] => [
    { kind: 'label', label: '移动到分类' },
    {
      kind: 'action',
      label: '📄 未分类',
      checked: p.category_id === null,
      disabled: p.category_id === null,
      onClick: () => void handleMove(p.id, null),
    },
    ...categories.map((c) => ({
      kind: 'action' as const,
      label: c.name,
      checked: p.category_id === c.id,
      disabled: p.category_id === c.id,
      onClick: () => void handleMove(p.id, c.id),
    })),
    // 手机端的删除是卡片上那颗两次点击键，不在弹层里：菜单一按就关，装不下一个常驻的二次确认
    ...(compact
      ? []
      : ([
          { kind: 'divider' },
          {
            kind: 'action',
            label: '🗑 删除演示文稿',
            tone: 'danger',
            disabled: deleting === p.id,
            onClick: () => askDelete(p.id),
          },
        ] as RowMenuItem[])),
  ];

  const askDelete = (id: number) => {
    if (confirm('确定删除这个演示文稿吗？')) void handleDelete(id);
  };

  const handleDelete = async (id: number) => {
    setDeleting(id);
    try {
      const res = await fetch(`/api/presentations/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        setNotice({ tone: 'error', text: await errorOf(res, '删除失败') });
        return;
      }
      setPresentations((prev) => prev.filter((p) => p.id !== id));
      setTotalCount((c) => c - 1);
      void loadCategories();
    } finally {
      setDeleting(null);
    }
  };

  const handleCreateNew = () => {
    // 免费版检查
    if (!pro && totalCount >= FREE_PPT_LIMIT) {
      setQuota(true);
      return;
    }
    router.push('/editor/new');
  };

  const handleImportClick = () => {
    // 挑文件的这几秒够下完整条导入链，别等选中文件才开始拉（配额挡住时预取就是白下）
    if (pro || totalCount < FREE_PPT_LIMIT) void loadPptxPipeline();
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (!pro && totalCount >= FREE_PPT_LIMIT) {
      setQuota(true);
      return;
    }
    setImporting(true);
    setImportLabel('解析中…');
    try {
      await runPptxImport(f, {
        cloud: cloudReady && importCloud,
        setImportNotice,
        push: (path) => router.push(path),
        onProgress: setImportLabel,
      });
    } catch (err) {
      setNotice({
        tone: 'error',
        text: '导入失败：' + (err instanceof Error ? err.message : '无法解析该文件'),
      });
    } finally {
      setImporting(false);
      setImportLabel('');
    }
  };

  // 过滤后的列表
  const filtered = activeCat === 'all'
    ? presentations
    : activeCat === 'null'
      ? presentations.filter((p) => p.category_id === null)
      : presentations.filter((p) => p.category_id === activeCat);

  // 侧栏那行「未分类」一直没有计数，手机端的筛选 chip 要带上它才知道点了会少几个
  const uncategorized = presentations.filter((p) => p.category_id === null).length;

  // 手机上不能提 .pptx 导入——那个入口在手机上根本不出现，写了就是句假话
  const quotaText = `免费版最多 ${FREE_PPT_LIMIT} 个演示文稿，新建已被拦下。可以先删掉一个，或升级 Pro 解锁无限数量${
    compact ? '' : '与 .pptx 导入'
  }。`;
  const bar: Notice | null = notice ?? (quota ? { tone: 'warn', text: quotaText } : null);
  const closeBar = () => {
    setNotice(null);
    setQuota(false);
  };

  // Pro 升级由服务端裁决（未接支付时生产环境会拒绝，并返回原因）
  const handleUpgradePro = async () => {
    const res = await fetch('/api/auth/pro', { method: 'POST' });
    if (res.ok) {
      setPro(true);
      setSheet(null);
      setNotice({ tone: 'ok', text: '🎉 升级成功！PPT 数量不再受限。' });
      return;
    }
    // 失败得留在窗里说：窗盖在主区上面，提示条只写在窗外面等于没说
    setNotice({ tone: 'error', text: await errorOf(res, '升级失败') });
  };

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      router.replace('/login');
    }
  };

  return (
    <div className={compact ? 'min-h-dvh flex flex-col bg-[#0f0f14]' : 'h-dvh flex bg-[#0f0f14]'}>
      {/* 手机端：侧栏那一整块（新建/导入/分类/账户）换成贴顶顶栏 + 一条分类筛选行 + 两个抽屉窗。
          整页自然滚动，不再用「侧栏 + 内部滚动的主区」——224px 的栏在 356px 屏上会把主区挤没。 */}
      {compact && (
        <>
          <header className="sticky top-0 z-20 shrink-0 h-14 px-3 flex items-center gap-2 bg-[#111119] border-b border-white/10">
            <button
              onClick={() => setSheet('account')}
              title="账户"
              className="shrink-0 w-11 h-11 rounded-lg bg-white/10 active:bg-white/25 text-lg text-gray-300"
            >
              ☰
            </button>
            <div className="flex-1 min-w-0">
              <div className="text-base font-semibold leading-tight truncate">我的演示文稿</div>
              <div className="text-[11px] leading-tight text-gray-500 truncate">
                {isGuest ? (
                  <span>游客模式 · <Link href="/login" className="text-blue-400">注册保存数据</Link></span>
                ) : pro ? (
                  <span className="text-yellow-400">⭐ Pro 会员</span>
                ) : (
                  <>
                    免费版 · {totalCount}/{FREE_PPT_LIMIT} 个
                  </>
                )}
              </div>
            </div>
            <button
              onClick={handleCreateNew}
              className="shrink-0 h-11 px-3 rounded-lg bg-blue-600 active:bg-blue-700 text-sm font-semibold"
            >
              ＋ 新建
            </button>
          </header>

          <div className="bg-strip-scroll sticky top-14 z-10 shrink-0 flex gap-1.5 overflow-x-auto overflow-y-hidden px-3 pt-3 pb-1 bg-[#0f0f14]">
            <FilterChip
              label={`全部 · ${totalCount}`}
              active={activeCat === 'all'}
              onClick={() => setActiveCat('all')}
            />
            <FilterChip
              label={`未分类 · ${uncategorized}`}
              active={activeCat === 'null'}
              onClick={() => setActiveCat('null')}
            />
            {categories.map((c) => (
              <FilterChip
                key={c.id}
                label={`${c.name} · ${c.ppt_count}`}
                active={activeCat === c.id}
                onClick={() => setActiveCat(c.id)}
              />
            ))}
            <button
              onClick={() => setSheet('cats')}
              className="shrink-0 h-11 px-3 rounded-lg text-sm bg-white/15 text-white active:bg-white/25"
            >
              ＋ 分类
            </button>
          </div>
        </>
      )}

      {/* 左侧边栏 */}
      {!compact && (
      <aside className="w-56 shrink-0 border-r border-white/10 bg-[#111119] flex flex-col">
        <div className="p-4 border-b border-white/10">
          <div className="text-lg font-bold">📊 PPT Player</div>
          <div className="text-xs text-gray-500 mt-1">
            {isGuest ? (
              <span>游客模式 · <Link href="/login" className="text-blue-400 hover:underline">注册保存数据</Link></span>
            ) : pro ? (
              <span className="text-yellow-400">⭐ Pro 会员</span>
            ) : (
              <>免费 · {totalCount}/{FREE_PPT_LIMIT} 个</>
            )}
          </div>
        </div>

        {/* Pro Banner */}
        {!pro && (
          <div className="m-3 p-3 rounded-lg bg-gradient-to-br from-yellow-600/30 to-orange-600/20 border border-yellow-600/30">
            <div className="text-xs text-yellow-300 font-semibold mb-1">⭐ 升级 Pro</div>
            <div className="text-[11px] text-gray-400 mb-2">无限 PPT + 导入 .pptx</div>
            <button
              onClick={handleUpgradePro}
              className="w-full py-1.5 text-xs rounded bg-yellow-600 hover:bg-yellow-500 text-black font-semibold transition"
            >
              升级
            </button>
          </div>
        )}

        {/* 快捷操作 */}
        <div className="p-3 space-y-2 border-b border-white/10">
          <button
            onClick={handleCreateNew}
            className="w-full py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 transition"
          >
            + 新建 PPT
          </button>
          <button
            onClick={handleImportClick}
            disabled={importing}
            className="w-full py-2 text-sm rounded-lg bg-white/10 hover:bg-white/20 transition disabled:opacity-50"
          >
            {importing ? `⏳ ${importLabel || '导入中...'}` : '📂 导入 .pptx'}
          </button>
          <label className="flex items-start gap-1.5 px-0.5 text-[11px] leading-snug text-gray-400">
            <input
              type="checkbox"
              checked={cloudReady && importCloud}
              onChange={(e) => setImportCloud(e.target.checked)}
              disabled={!cloudReady || importing}
              className="mt-0.5 shrink-0 accent-blue-600 disabled:cursor-not-allowed"
            />
            <span className={cloudReady ? '' : 'text-yellow-400/80'}>
              {cloudReady
                ? '导入的图片传上云端（换设备也看得到）'
                : '云端素材地址未配置，导入的图片只能存在本机'}
            </span>
          </label>
          <input ref={fileInputRef} type="file" accept=".pptx" className="hidden" onChange={handleFileChange} />
        </div>

        {/* 分类列表 */}
        <div className="flex-1 overflow-y-auto p-3 space-y-0.5">
          <div className="flex items-center justify-between text-xs text-gray-500 mb-2 px-1">
            <span>📁 分类</span>
            <button
              onClick={() => setShowNewCat((v) => !v)}
              className="text-gray-400 hover:text-white"
              title="新建分类"
            >+</button>
          </div>

          {showNewCat && (
            <div className="flex gap-1 mb-1">
              <input
                autoFocus
                value={newCatName}
                onChange={(e) => setNewCatName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAddCategory()}
                placeholder="分类名"
                className="flex-1 px-2 py-1 text-xs rounded bg-white/5 border border-white/10 focus:border-blue-500 outline-none"
              />
              <button onClick={handleAddCategory} className="px-2 text-xs rounded bg-blue-600 hover:bg-blue-500">确定</button>
            </div>
          )}

          <button
            onClick={() => setActiveCat('all')}
            className={`w-full text-left px-2 py-1.5 rounded text-sm flex items-center justify-between ${
              activeCat === 'all' ? 'bg-white/10 text-white' : 'text-gray-400 hover:bg-white/5'
            }`}
          >
            <span>全部</span>
            <span className="text-xs text-gray-500">{totalCount}</span>
          </button>
          <button
            onClick={() => setActiveCat('null')}
            className={`w-full text-left px-2 py-1.5 rounded text-sm flex items-center justify-between ${
              activeCat === 'null' ? 'bg-white/10 text-white' : 'text-gray-400 hover:bg-white/5'
            }`}
          >
            <span>📄 未分类</span>
          </button>
          {categories.map((c) => (
            <div key={c.id} className="flex items-center gap-1">
              {renamingId === c.id ? (
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={handleRenameConfirm}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRenameConfirm();
                    if (e.key === 'Escape') setRenamingId(null);
                  }}
                  className="flex-1 min-w-0 text-left px-2 py-1.5 rounded bg-white/10 text-white text-sm outline-none border border-blue-500"
                />
              ) : (
                <button
                  onClick={() => setActiveCat(c.id)}
                  className={`flex-1 min-w-0 text-left px-2 py-1.5 rounded text-sm flex items-center justify-between gap-2 ${
                    activeCat === c.id ? 'bg-white/10 text-white' : 'text-gray-400 hover:bg-white/5'
                  }`}
                >
                  <span className="truncate">{c.name}</span>
                  <span className="text-xs text-gray-500 shrink-0">{c.ppt_count}</span>
                </button>
              )}
              <RowMenu
                width={190}
                title="分类操作"
                items={[
                  { kind: 'action', label: '✏️ 重命名', onClick: () => startRename(c) },
                  { kind: 'divider' },
                  {
                    kind: 'action',
                    label: '🗑 删除分类',
                    tone: 'danger',
                    onClick: () => askDeleteCategory(c),
                  },
                ]}
              />
            </div>
          ))}
        </div>

        <div className="p-3 border-t border-white/10 space-y-2">
          {isAdmin && (
            <Link href="/admin" className="block text-xs text-gray-400 hover:text-white">
              ⚙️ 后台管理
            </Link>
          )}
          {isGuest ? (
            <Link href="/login" className="text-xs text-blue-400 hover:text-white">
              注册 / 登录
            </Link>
          ) : (
            <button
              onClick={handleLogout}
              disabled={loggingOut}
              className="text-xs text-gray-500 hover:text-white disabled:opacity-50"
            >
              {loggingOut ? '退出中...' : '退出登录'}
            </button>
          )}
        </div>
      </aside>
      )}

      {/* 右侧主区（手机端是整页往下滚的那一段，不再自带滚动条） */}
      <main className={compact ? 'flex-1 px-3 pb-8 pt-4' : 'flex-1 overflow-y-auto p-8'}>
        {bar && <NoticeBar notice={bar} onClose={closeBar} />}

        {!compact && (
        <div className="mb-6">
          <h1 className="text-2xl font-bold">我的演示文稿</h1>
          <p className="text-sm text-gray-500 mt-1">
            {activeCat === 'all' ? '全部' : activeCat === 'null' ? '未分类' : categories.find((c) => c.id === activeCat)?.name}
            （{filtered.length} 个）
          </p>
        </div>
        )}

        {filtered.length === 0 ? (
          <div className="text-center py-20 text-gray-500">
            <div className="text-5xl mb-4">📭</div>
            <p className="mb-4">这里空空如也</p>
            <button
              onClick={handleCreateNew}
              className={
                compact
                  ? 'h-11 px-6 rounded-lg bg-blue-600 active:bg-blue-700 transition'
                  : 'px-6 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 transition'
              }
            >
              + 创建第一个 PPT
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map((p) => (
              <div
                key={p.id}
                className={
                  compact
                    ? 'p-4 rounded-xl border border-white/10 bg-white/5 active:opacity-80 transition'
                    : 'p-5 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 transition'
                }
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="text-3xl">📊</div>
                  <RowMenu
                    width={200}
                    size={compact ? 'lg' : 'sm'}
                    title="演示文稿操作"
                    items={cardMenuItems(p)}
                  />
                </div>

                <h3
                  className={`${compact ? 'text-base' : 'text-lg'} font-semibold mb-1 truncate`}
                  title={p.title}
                >
                  {p.title}
                </h3>
                <p className="text-xs text-gray-500 mb-3">
                  {deleting === p.id
                    ? '删除中…'
                    : `${p.slide_count} 页 · 更新于 ${new Date(p.updated_at).toLocaleString('zh-CN')}`}
                </p>
                {p.category_name && (
                  <span className="inline-block text-[10px] px-2 py-0.5 rounded bg-blue-600/20 text-blue-400 mb-3">
                    {p.category_name}
                  </span>
                )}

                {compact ? (
                  // 手机端把删除从弹层里搬到动作行：弹层一按就关，装不下一个常驻的二次确认
                  <div className="flex gap-2 mt-2">
                    <Link
                      href={`/editor/${p.id}`}
                      className="flex-1 h-11 flex items-center justify-center rounded-lg bg-white/10 active:bg-white/25 transition text-sm"
                    >
                      ✏️ 编辑
                    </Link>
                    <Link
                      href={`/play/${p.id}`}
                      className="flex-1 h-11 flex items-center justify-center rounded-lg bg-blue-600 active:bg-blue-700 transition text-sm"
                    >
                      ▶ 播放
                    </Link>
                    <ConfirmKey
                      key={`del-${p.id}`}
                      label="🗑 删除"
                      confirmLabel="再点一次就删"
                      onConfirm={() => void handleDelete(p.id)}
                    />
                  </div>
                ) : (
                  <div className="flex gap-2 mt-2">
                    <Link
                      href={`/editor/${p.id}`}
                      className="flex-1 text-center py-2 rounded-lg bg-white/10 hover:bg-white/20 transition text-sm"
                    >
                      ✏️ 编辑
                    </Link>
                    <Link
                      href={`/play/${p.id}`}
                      className="flex-1 text-center py-2 rounded-lg bg-blue-600 hover:bg-blue-700 transition text-sm"
                    >
                      ▶ 播放
                    </Link>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </main>

      {/* 手机端两个抽屉窗：分类管理和账户。桌面端这些都在侧栏里，永远不走这条分支 */}
      {compact && sheet && (
        <SheetOverlay
          title={sheet === 'cats' ? '分类管理' : '账户'}
          onClose={() => {
            setSheet(null);
            // 关窗时还停在改名态的话，下次开就会对着一个空输入框
            setRenamingId(null);
          }}
          keyboardInset={keyboardInset}
        >
          {/* 提示条在窗里也要出一份：窗盖在主区上面，只写在主区里等于没说 */}
          {bar && <NoticeBar notice={bar} onClose={closeBar} />}
          {sheet === 'cats' ? (
            <>
              <SheetHint>
                删除分类只会把下面的 PPT 变成未分类，内容不会丢。点名字可以改名。
              </SheetHint>
              <div className="flex gap-1.5">
                <input
                  value={newCatName}
                  onChange={(e) => setNewCatName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void handleAddCategory()}
                  placeholder="新分类名"
                  className="flex-1 min-w-0 h-11 px-3 rounded-lg bg-black/30 border border-white/10 text-base outline-none focus:border-blue-500"
                />
                <button
                  onClick={() => void handleAddCategory()}
                  className="shrink-0 h-11 px-3 rounded-lg bg-blue-600 active:bg-blue-700 text-sm"
                >
                  确定
                </button>
              </div>
              {categories.length === 0 ? (
                <SheetHint>还没有分类，上面输个名字建一个。</SheetHint>
              ) : (
                categories.map((c) => (
                  <div key={c.id} className="flex gap-1.5 items-center">
                    {renamingId === c.id ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => void handleRenameConfirm()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void handleRenameConfirm();
                          if (e.key === 'Escape') setRenamingId(null);
                        }}
                        className="flex-1 min-w-0 h-11 px-3 rounded-lg bg-white/10 border border-blue-500 text-base outline-none"
                      />
                    ) : (
                      <button
                        onClick={() => startRename(c)}
                        className="flex-1 min-w-0 h-11 px-3 rounded-lg bg-white/5 active:bg-white/15 text-left text-sm flex items-center justify-between gap-2"
                      >
                        <span className="truncate">{c.name}</span>
                        <span className="text-xs text-gray-500 shrink-0">{c.ppt_count} 个 · 改名</span>
                      </button>
                    )}
                    <ConfirmKey
                      key={`cat-${c.id}`}
                      label="🗑 删除"
                      confirmLabel="再点一次就删"
                      onConfirm={() => void handleDeleteCategory(c)}
                    />
                  </div>
                ))
              )}
            </>
          ) : (
            <>
              <div className="text-sm text-gray-200">
                {isGuest ? (
                  <span>游客模式 · 数据存在当前浏览器</span>
                ) : pro ? (
                  <span className="text-yellow-400">⭐ Pro 会员</span>
                ) : (
                  <>
                    免费版 · 已用 {totalCount}/{FREE_PPT_LIMIT} 个演示文稿
                  </>
                )}
              </div>
              {isGuest ? (
                <Link
                  href="/login"
                  className="h-11 rounded-lg bg-blue-600 active:bg-blue-700 text-sm font-semibold text-center flex items-center justify-center"
                >
                  注册 / 登录 — 保存数据到云端
                </Link>
              ) : (
                <>
                  {!pro && (
                    <button
                      onClick={() => void handleUpgradePro()}
                      className="h-11 rounded-lg bg-yellow-600 active:bg-yellow-500 text-black text-sm font-semibold"
                    >
                      升级 Pro — 无限 PPT
                    </button>
                  )}
                  <button
                    onClick={() => void handleLogout()}
                    disabled={loggingOut}
                    className="h-11 rounded-lg bg-white/10 active:bg-white/20 text-sm text-gray-300 disabled:opacity-50"
                  >
                    {loggingOut ? '退出中...' : '退出登录'}
                  </button>
                </>
              )}
              {isAdmin && (
                <Link
                  href="/admin"
                  className="h-11 rounded-lg bg-white/10 active:bg-white/20 text-sm text-gray-300 flex items-center justify-center"
                >
                  ⚙️ 后台管理
                </Link>
              )}
              <SheetHint>
                手机上没有 .pptx 导入：大文件在手机上要解析十几秒，而且手机浏览器常常拿不到原始文件。请在电脑上导入。
              </SheetHint>
            </>
          )}
        </SheetOverlay>
      )}
    </div>
  );
}
