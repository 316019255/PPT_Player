/* eslint-disable @next/next/no-img-element -- 素材地址是管理员填的任意图床域名，next/image 要预先固定的 remotePatterns，这里直接用 img */
'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import type { CategoryCount, MaterialRow } from '@/lib/admin-data';
import { cloudPublicUrl, isLibraryCloudPath } from '@/lib/media-source';
import { ruleForMime, sniffMediaMime, type MediaKind } from '@/lib/media-ext';
import { SIGN_ENDPOINT, makeImageThumb, makeVideoThumb, uploadMediaToCloud } from '@/lib/mediaClient';
import NoticeBar, { type Notice } from '@/components/NoticeBar';
import { ConfirmKey } from '@/components/PhoneDock';

const EMPTY_FORM = {
  kind: 'image',
  url: '',
  thumb_url: '',
  title: '',
  category: '未分类',
  tags: '',
  alt: '',
  sort: '0',
};

const EMPTY_UPLOAD = { file: null as File | null, title: '', category: '未分类', sort: '0', poster: '' };

const INPUT = 'w-full mt-1 px-3 py-2 rounded-lg bg-white/10 border border-white/20 text-sm';

/** <input type=number> 交出来的是字符串；空着或填了小数就按 0 处理，接口那边还会再校一遍 */
function intOf(value: string): number {
  const n = Number(value.trim());
  return Number.isInteger(n) ? n : 0;
}

/** 桶内路径（lib/…）在后台也得拼上公开前缀才显示得出来，和前台格子同一句拼法 */
function viewOf(value: string): string {
  return cloudPublicUrl(value) || value;
}

const kindText = (kind: string) => (kind === 'video' ? '视频' : '图片');

/** 按文件头魔数认类型：File.name 的后缀和 File.type 都能被系统填错，字节不会 */
async function detectKind(file: File): Promise<MediaKind | null> {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const mime = sniffMediaMime(head);
  return mime ? (ruleForMime(mime)?.kind ?? null) : null;
}

/** 选完文件先给一句人话：管理员在按「上传」之前就知道这次传的是哪一种、多大 */
async function sniffLabel(file: File): Promise<string> {
  const size = `${(file.size / 1024 / 1024).toFixed(2)}MB`;
  const kind = await detectKind(file);
  return kind
    ? `认出来了：${kindText(kind)} · ${size}`
    : `认不出这是哪一种（${size}），只收 png / jpg / webp / gif / bmp / avif 和 mp4 / webm / ogg / mov`;
}

/** 删除确认框：删记录之前先问清有几份稿子在引用它 */
interface DeleteTarget {
  row: MaterialRow;
  refs: number | null;
  purge: boolean;
}

export default function MaterialsClient({
  initialMaterials,
  initialCategories,
}: {
  initialMaterials: MaterialRow[];
  initialCategories: CategoryCount[];
}) {
  const [materials, setMaterials] = useState(initialMaterials);
  const [categories, setCategories] = useState(initialCategories);
  const [kindFilter, setKindFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addMode, setAddMode] = useState<'upload' | 'link'>('upload');
  const [newMaterial, setNewMaterial] = useState(EMPTY_FORM);
  const [upload, setUpload] = useState(EMPTY_UPLOAD);
  const [kindHint, setKindHint] = useState('');
  const [uploading, setUploading] = useState(false);
  const [editing, setEditing] = useState<MaterialRow | null>(null);
  const [draft, setDraft] = useState({ title: '', category: '', sort: '0' });
  const [deleting, setDeleting] = useState<DeleteTarget | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // 只有事件回调里会重查（筛选、增删改之后），所以首屏不需要 useEffect 兜一次
  async function load(kind: string, category: string) {
    setBusy(true);
    try {
      const [matRes, catRes] = await Promise.all([
        fetch(`/api/admin/materials?kind=${kind === 'all' ? '' : kind}&category=${category}`),
        fetch('/api/admin/materials/categories'),
      ]);
      const matData = await matRes.json();
      const catData = await catRes.json();
      setMaterials(matData.materials || []);
      setCategories(catData.categories || []);
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

  const openAdd = (mode: 'upload' | 'link') => {
    setAddMode(mode);
    setNewMaterial(EMPTY_FORM);
    setUpload(EMPTY_UPLOAD);
    setKindHint('');
    setShowAdd(true);
  };

  /** 上传模式：字节先直传桶，拿到路径再入库 —— 库里存的永远只是桶内路径，不含域名 */
  const handleUpload = async () => {
    const file = upload.file;
    if (!file) {
      setNotice({ tone: 'error', text: '先选一个文件' });
      return;
    }
    setUploading(true);
    try {
      const kind = await detectKind(file);
      if (!kind) {
        setNotice({ tone: 'error', text: '认不出这是图片还是视频，只收 png / jpg / webp / gif / bmp / avif 和 mp4 / webm / ogg / mov' });
        return;
      }

      const main = await uploadMediaToCloud(file, kind, SIGN_ENDPOINT.library);
      if (!main.ok) {
        setNotice({ tone: 'error', text: main.reason });
        return;
      }

      // 图片 / 视频都顺手压一张 320px 的缩略图一起进桶：前台格子拉这张，不拉原图 / 整段视频
      let thumbPath = '';
      let thumbFailed = false;
      if (kind === 'image') {
        const thumbBlob = await makeImageThumb(file);
        if (thumbBlob) {
          const thumb = await uploadMediaToCloud(thumbBlob, 'image', SIGN_ENDPOINT.library);
          if (thumb.ok) thumbPath = thumb.path;
          else thumbFailed = true;
        } else {
          thumbFailed = true;
        }
      } else if (kind === 'video') {
        const thumbBlob = await makeVideoThumb(file);
        if (thumbBlob) {
          const thumb = await uploadMediaToCloud(thumbBlob, 'image', SIGN_ENDPOINT.library);
          if (thumb.ok) thumbPath = thumb.path;
          else thumbFailed = true;
        } else {
          thumbFailed = true;
        }
      }

      const res = await fetch('/api/admin/materials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind,
          url: main.path,
          // 缩略图优先用自动生成的（图片 / 视频都走这条路），管理员填的封面只在没有自动生成时兜底
          thumb_url: thumbPath || (kind === 'video' ? upload.poster.trim() : ''),
          title: upload.title.trim(),
          category: upload.category.trim(),
          sort: intOf(upload.sort),
        }),
      });
      if (!res.ok) {
        await reportFailure(res, '入库失败');
        return;
      }
      setShowAdd(false);
      setUpload(EMPTY_UPLOAD);
      setKindHint('');
      if (fileRef.current) fileRef.current.value = '';
      await load(kindFilter, categoryFilter);

      const notes: string[] = [];
      if (main.reused) notes.push('云端已经有同一份内容，这次没有重传字节');
      if (thumbFailed) notes.push('缩略图没生成，前台格子会直接拉原图');
      setNotice({
        tone: notes.length ? 'warn' : 'ok',
        text: [`已入库：${main.path}`, ...notes].join('\n'),
      });
    } finally {
      setUploading(false);
    }
  };

  const handleAddLink = async () => {
    if (!newMaterial.url.trim()) {
      setNotice({ tone: 'error', text: '地址不能空着' });
      return;
    }
    const res = await fetch('/api/admin/materials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...newMaterial, sort: intOf(newMaterial.sort) }),
    });
    if (res.ok) {
      setShowAdd(false);
      setNewMaterial(EMPTY_FORM);
      await load(kindFilter, categoryFilter);
      setNotice({ tone: 'ok', text: '已入库' });
    } else {
      await reportFailure(res, '添加失败');
    }
  };

  const openEdit = (m: MaterialRow) => {
    setEditing(m);
    setDraft({ title: m.title, category: m.category, sort: String(m.sort) });
  };

  /** 可改的就 title / category / sort / enabled：地址和类型改了等于换了一条素材，走「新增 + 下线旧的」 */
  const handleSave = async () => {
    if (!editing) return;
    const res = await fetch('/api/admin/materials', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: editing.id,
        title: draft.title.trim(),
        category: draft.category.trim(),
        sort: intOf(draft.sort),
        enabled: editing.enabled,
      }),
    });
    if (res.ok) {
      setEditing(null);
      await load(kindFilter, categoryFilter);
      setNotice({ tone: 'ok', text: '已保存' });
    } else {
      await reportFailure(res, '保存失败');
    }
  };

  /** 引用数是点删除时才查的：这份计数要扫全部稿子的 data，挂在列表上每次筛选都付一遍 */
  const openDelete = async (m: MaterialRow) => {
    setDeleting({ row: m, refs: null, purge: false });
    const res = await fetch(`/api/admin/materials/refs?id=${m.id}`);
    const data = res.ok ? await res.json().catch(() => null) : null;
    setDeleting((cur) => (cur && cur.row.id === m.id ? { ...cur, refs: typeof data?.refs === 'number' ? data.refs : 0 } : cur));
  };

  const handleDelete = async () => {
    if (!deleting) return;
    const { row, purge } = deleting;
    setDeleting(null);
    const res = await fetch(`/api/admin/materials?id=${row.id}${purge ? '&file=1' : ''}`, { method: 'DELETE' });
    if (!res.ok) {
      await reportFailure(res, '删除失败');
      return;
    }
    await load(kindFilter, categoryFilter);
    const data = await res.json().catch(() => null);
    const failures: string[] = Array.isArray(data?.failures) ? data.failures : [];
    if (failures.length) {
      setNotice({ tone: 'warn', text: `记录已删除，但桶里的文件没删掉：\n${failures.join('\n')}` });
    } else {
      setNotice({ tone: 'ok', text: purge ? '已删除记录并清掉了桶内文件' : '已删除记录（桶内文件保留）' });
    }
  };

  const onlineCount = materials.filter((m) => m.enabled).length;

  return (
    <div className="min-h-dvh bg-[#0f0f14] text-[#e0e0e0]">
      <header className="px-6 py-4 flex items-center justify-between border-b border-white/10">
        <div className="flex items-center gap-4">
          <Link href="/admin" className="text-gray-400 hover:text-white">← 返回</Link>
          <div className="text-xl font-bold">素材管理</div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => openAdd('link')}
            className="px-3 py-2 rounded-lg bg-white/10 hover:bg-white/20 transition text-sm"
            title="直接把图床/视频地址填进来，字节不过我们的桶"
          >
            + 粘外链
          </button>
          <button
            onClick={() => openAdd('upload')}
            className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 transition text-sm font-semibold"
          >
            + 上传素材
          </button>
        </div>
      </header>

      <div className="p-6">
        {notice && <NoticeBar notice={notice} onClose={() => setNotice(null)} />}

        {/* 筛选 */}
        <div className="flex gap-3 mb-6 flex-wrap items-center">
          <select
            value={kindFilter}
            onChange={(e) => {
              const next = e.target.value;
              setKindFilter(next);
              void load(next, categoryFilter);
            }}
            className="px-3 py-2 rounded-lg bg-white/10 border border-white/20 text-sm"
          >
            <option value="all">全部类型</option>
            <option value="image">图片</option>
            <option value="video">视频</option>
          </select>

          <select
            value={categoryFilter}
            onChange={(e) => {
              const next = e.target.value;
              setCategoryFilter(next);
              void load(kindFilter, next);
            }}
            className="px-3 py-2 rounded-lg bg-white/10 border border-white/20 text-sm"
          >
            <option value="all">全部分类</option>
            {categories.map((c) => (
              <option key={c.category} value={c.category}>
                {c.category} ({c.count})
              </option>
            ))}
          </select>

          <span className="text-xs text-gray-500">
            共 {materials.length} 条 · 前台可见 {onlineCount} 条
          </span>
          {busy && <span className="text-xs text-gray-500">刷新中…</span>}
        </div>

        {/* 素材列表 */}
        {materials.length === 0 ? (
          <div className="text-center py-20 text-gray-500">
            <div className="text-5xl mb-4">📭</div>
            <p>暂无素材</p>
            <p className="text-xs mt-2">
              前台的在线背景就取自这张表；表空着，编辑器的在线素材就是「暂时不可用」。
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {materials.map((m) => (
              <div
                key={m.id}
                className={`rounded-lg overflow-hidden border bg-white/5 ${
                  m.enabled ? 'border-white/10' : 'border-white/5'
                }`}
              >
                <div className="aspect-video bg-black/50 flex items-center justify-center relative">
                  {m.kind === 'image' ? (
                    <img
                      src={viewOf(m.thumb_url || m.url)}
                      alt={m.alt || m.title}
                      className={`w-full h-full object-cover pointer-events-none ${m.enabled ? '' : 'opacity-40'}`}
                    />
                  ) : (
                    <video
                      src={viewOf(m.thumb_url || m.url)}
                      className={`w-full h-full object-cover pointer-events-none ${m.enabled ? '' : 'opacity-40'}`}
                      muted
                      playsInline
                      preload="metadata"
                    />
                  )}
                  {!m.enabled && (
                    <span className="absolute top-2 left-2 text-xs px-2 py-0.5 rounded bg-black/70 text-gray-300 z-10">
                      已下线
                    </span>
                  )}
                </div>
                <div className="p-3">
                  <div className="text-sm truncate" title={m.title}>{m.title || '（未命名）'}</div>
                  <div className="text-xs text-gray-400 truncate" title={m.url}>{m.url}</div>
                  <div className="flex items-center justify-between mt-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs px-2 py-0.5 rounded bg-white/10">{m.category}</span>
                      <button
                        onClick={() => void openEdit(m)}
                        className="text-xs text-blue-400 hover:text-blue-300 transition"
                      >
                        编辑
                      </button>
                      <button
                        onClick={() => void openDelete(m)}
                        className="text-xs text-red-400 hover:text-red-300 transition"
                      >
                        删除
                      </button>
                    </div>
                    <span className="text-xs text-gray-500">
                      {kindText(m.kind)} · {m.sort}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 添加素材：上传到桶 or 填外部地址，两条路都落到同一张表 */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="bg-[#1a1a24] rounded-xl p-6 max-w-md w-full border border-white/10 max-h-[90dvh] overflow-y-auto">
            <h2 className="text-lg font-semibold mb-4">添加素材</h2>

            <div className="flex gap-1 bg-white/5 rounded-lg p-1 mb-4 text-sm">
              {(['upload', 'link'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setAddMode(mode)}
                  className={`flex-1 py-1.5 rounded transition ${
                    addMode === mode ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'
                  }`}
                >
                  {mode === 'upload' ? '上传到云端桶' : '填外部地址'}
                </button>
              ))}
            </div>

            {addMode === 'upload' ? (
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-gray-400">文件 *（图片 ≤12MB / 视频 ≤48MB）</label>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif,video/mp4,video/webm,video/ogg,video/quicktime"
                    onChange={async (e) => {
                      const file = e.target.files?.[0] ?? null;
                      setUpload((cur) => ({ ...cur, file }));
                      setKindHint(file ? await sniffLabel(file) : '');
                    }}
                    className={INPUT}
                  />
                  <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                    {kindHint ||
                      '类型按文件头魔数认，不看文件名后缀。图片和视频都会自动压一张 320px 的缩略图一起进桶，前台格子只拉这张；字节走浏览器直传，不过应用服务器。'}
                  </p>
                </div>

                <div>
                  <label className="text-xs text-gray-400">名称（前台格子下面那行字）</label>
                  <input
                    type="text"
                    value={upload.title}
                    onChange={(e) => setUpload({ ...upload, title: e.target.value })}
                    className={INPUT}
                    maxLength={100}
                  />
                </div>

                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="text-xs text-gray-400">分类</label>
                    <input
                      type="text"
                      value={upload.category}
                      onChange={(e) => setUpload({ ...upload, category: e.target.value })}
                      className={INPUT}
                      maxLength={50}
                    />
                  </div>
                  <div className="w-24">
                    <label className="text-xs text-gray-400">排序</label>
                    <input
                      type="number"
                      value={upload.sort}
                      onChange={(e) => setUpload({ ...upload, sort: e.target.value })}
                      className={INPUT}
                    />
                  </div>
                </div>

                <div>
                  <label className="text-xs text-gray-400">封面图地址（视频建议填，省一次整段下载；图片留空自动生成）</label>
                  <input
                    type="text"
                    value={upload.poster}
                    onChange={(e) => setUpload({ ...upload, poster: e.target.value })}
                    className={INPUT}
                    placeholder="https://..."
                  />
                </div>

                <div className="flex gap-3 mt-6">
                  <button
                    onClick={() => setShowAdd(false)}
                    className="flex-1 py-2 rounded-lg bg-white/10 hover:bg-white/20 transition text-sm"
                  >
                    取消
                  </button>
                  <button
                    onClick={() => void handleUpload()}
                    disabled={uploading || !upload.file}
                    className="flex-1 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 transition text-sm font-semibold disabled:opacity-50"
                  >
                    {uploading ? '上传中…' : '上传并入库'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-gray-400">类型</label>
                  <select
                    value={newMaterial.kind}
                    onChange={(e) => setNewMaterial({ ...newMaterial, kind: e.target.value })}
                    className={INPUT}
                  >
                    <option value="image">图片</option>
                    <option value="video">视频</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs text-gray-400">URL *</label>
                  <input
                    type="text"
                    value={newMaterial.url}
                    onChange={(e) => setNewMaterial({ ...newMaterial, url: e.target.value })}
                    className={INPUT}
                    placeholder="https://..."
                  />
                </div>

                <div>
                  <label className="text-xs text-gray-400">缩略图 URL（可选，视频建议填，省一次整段下载）</label>
                  <input
                    type="text"
                    value={newMaterial.thumb_url}
                    onChange={(e) => setNewMaterial({ ...newMaterial, thumb_url: e.target.value })}
                    className={INPUT}
                  />
                </div>

                <div>
                  <label className="text-xs text-gray-400">名称（前台格子下面那行字）</label>
                  <input
                    type="text"
                    value={newMaterial.title}
                    onChange={(e) => setNewMaterial({ ...newMaterial, title: e.target.value })}
                    className={INPUT}
                    maxLength={100}
                  />
                </div>

                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="text-xs text-gray-400">分类</label>
                    <input
                      type="text"
                      value={newMaterial.category}
                      onChange={(e) => setNewMaterial({ ...newMaterial, category: e.target.value })}
                      className={INPUT}
                      maxLength={50}
                    />
                  </div>
                  <div className="w-24">
                    <label className="text-xs text-gray-400">排序</label>
                    <input
                      type="number"
                      value={newMaterial.sort}
                      onChange={(e) => setNewMaterial({ ...newMaterial, sort: e.target.value })}
                      className={INPUT}
                    />
                  </div>
                </div>

                <div>
                  <label className="text-xs text-gray-400">标签（逗号分隔，可选）</label>
                  <input
                    type="text"
                    value={newMaterial.tags}
                    onChange={(e) => setNewMaterial({ ...newMaterial, tags: e.target.value })}
                    className={INPUT}
                  />
                </div>

                <div>
                  <label className="text-xs text-gray-400">描述（可选，只用于无障碍）</label>
                  <input
                    type="text"
                    value={newMaterial.alt}
                    onChange={(e) => setNewMaterial({ ...newMaterial, alt: e.target.value })}
                    className={INPUT}
                    maxLength={200}
                  />
                </div>

                <div className="flex gap-3 mt-6">
                  <button
                    onClick={() => setShowAdd(false)}
                    className="flex-1 py-2 rounded-lg bg-white/10 hover:bg-white/20 transition text-sm"
                  >
                    取消
                  </button>
                  <button
                    onClick={() => void handleAddLink()}
                    className="flex-1 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 transition text-sm font-semibold"
                  >
                    添加
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 编辑素材弹窗 */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="bg-[#1a1a24] rounded-xl p-6 max-w-md w-full border border-white/10">
            <h2 className="text-lg font-semibold mb-1">编辑素材 #{editing.id}</h2>
            <div className="text-xs text-gray-400 mb-4 break-all">
              {kindText(editing.kind)} · {editing.url}
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-400">名称</label>
                <input
                  type="text"
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  className={INPUT}
                  maxLength={100}
                />
              </div>

              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="text-xs text-gray-400">分类</label>
                  <input
                    type="text"
                    value={draft.category}
                    onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                    className={INPUT}
                    maxLength={50}
                  />
                </div>
                <div className="w-24">
                  <label className="text-xs text-gray-400">排序</label>
                  <input
                    type="number"
                    value={draft.sort}
                    onChange={(e) => setDraft({ ...draft, sort: e.target.value })}
                    className={INPUT}
                  />
                </div>
              </div>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={editing.enabled === 1}
                  onChange={(e) => {
                    const enabled = e.target.checked ? 1 : 0;
                    setEditing({ ...editing, enabled });
                  }}
                  className="w-4 h-4"
                />
                <span className="text-sm">前台可见（取消勾选 = 下线）</span>
              </label>

              <p className="text-xs text-gray-500">排序大的排前面，同值按录入先后。地址和类型不能改。</p>
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setEditing(null)}
                className="flex-1 py-2 rounded-lg bg-white/10 hover:bg-white/20 transition text-sm"
              >
                取消
              </button>
              <button
                onClick={() => void handleSave()}
                className="flex-1 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 transition text-sm font-semibold"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除确认：默认只删记录，勾上才动桶里的字节 */}
      {deleting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="bg-[#1a1a24] rounded-xl p-6 max-w-md w-full border border-white/10">
            <h2 className="text-lg font-semibold mb-1">删除这条素材？</h2>
            <div className="text-xs text-gray-400 mb-4 break-all">
              {deleting.row.title || '（未命名）'} · {deleting.row.url}
            </div>

            <p className="text-sm leading-relaxed">
              {deleting.refs === null ? (
                <span className="text-gray-400">正在数有几份稿子在用它…</span>
              ) : deleting.refs > 0 ? (
                <>
                  <b className="text-yellow-300">{deleting.refs} 份</b>演示文稿正在引用它。删除记录不影响它们放映；
                  但一旦连桶里的文件一起删，那些稿子的这一处素材就再也渲染不出来了。
                </>
              ) : (
                '没有稿子引用它。'
              )}
            </p>

            {isLibraryCloudPath(deleting.row.url) ? (
              <label className="flex items-start gap-2 mt-4 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={deleting.purge}
                  onChange={(e) => setDeleting({ ...deleting, purge: e.target.checked })}
                  className="mt-0.5"
                />
                <span>
                  同时删除桶内文件
                  <span className="block text-xs text-gray-500">不可恢复。不勾就只删记录，文件留着，将来重新入库还能用。</span>
                </span>
              </label>
            ) : (
              <p className="mt-4 text-xs text-gray-500">这条是外部地址，桶里没有文件可删。</p>
            )}

            <div className="flex gap-3 mt-6 items-stretch">
              <button
                onClick={() => setDeleting(null)}
                className="flex-1 py-2 rounded-lg bg-white/10 hover:bg-white/20 transition text-sm"
              >
                取消
              </button>
              {/* 引用数没回来之前不给删：那颗键按下去的意义是「我知道有几份稿子在用它」 */}
              {deleting.refs === null ? (
                <span className="flex-1 py-2 rounded-lg bg-white/5 text-center text-sm text-gray-500">
                  正在查引用…
                </span>
              ) : (
                <ConfirmKey
                  label={deleting.purge ? '🗑 删记录和文件' : '🗑 只删记录'}
                  confirmLabel="再点一次就删"
                  onConfirm={() => void handleDelete()}
                />
              )}
            </div>
            {deleting.purge && (
              <p className="mt-2 text-xs text-gray-500">勾了「同时删除桶内文件」，右边那颗要按两下才动手。</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
