'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  GRANT_DAYS_MAX,
  USER_PAGE_SIZE,
  membershipLabel,
  type AdminUserRow,
  type Membership,
  type UserTier,
} from '@/lib/admin-users';
import NoticeBar, { type Notice } from '@/components/NoticeBar';
import RowMenu from '@/components/RowMenu';
import { ConfirmKey } from '@/components/PhoneDock';

const TIERS: { value: UserTier; label: string }[] = [
  { value: 'all', label: '全部注册用户' },
  { value: 'pro', label: '会员' },
  { value: 'free', label: '普通' },
  { value: 'guest', label: '游客（免登录）' },
];

/** 会员状态那一列的颜色。按状态取，不按文案取 —— 「至 2027-10-19」这种带日期的文案是变量 */
const TONE: Record<Membership, string> = {
  permanent: 'text-yellow-400',
  active: 'text-yellow-400',
  expired: 'text-red-400',
  guest: 'text-gray-500',
  free: 'text-gray-400',
};

interface Query {
  tier: UserTier;
  q: string;
  page: number;
}

export default function UsersClient({
  initialUsers,
  initialTotal,
}: {
  initialUsers: AdminUserRow[];
  initialTotal: number;
}) {
  const [users, setUsers] = useState(initialUsers);
  const [total, setTotal] = useState(initialTotal);
  const [query, setQuery] = useState<Query>({ tier: 'all', q: '', page: 1 });
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [daysFor, setDaysFor] = useState<AdminUserRow | null>(null);
  const [daysInput, setDaysInput] = useState('30');
  const [revoking, setRevoking] = useState<AdminUserRow | null>(null);

  const pages = Math.max(1, Math.ceil(total / USER_PAGE_SIZE));

  async function load(next: Query) {
    setBusy(true);
    try {
      const params = new URLSearchParams({ tier: next.tier, page: String(next.page) });
      if (next.q) params.set('q', next.q);
      const res = await fetch(`/api/admin/users?${params}`);
      if (!res.ok) {
        await reportFailure(res, '列表刷新失败');
        return;
      }
      const data = await res.json();
      setQuery(next);
      setUsers(data.users || []);
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

  /** 到期时间由服务端算：这里只发表达意图（permanent / {days} / revoke） */
  async function applyGrant(row: AdminUserRow, grant: unknown, done: string) {
    const res = await fetch('/api/admin/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: row.id, grant }),
    });
    if (!res.ok) {
      await reportFailure(res, '操作失败');
      return false;
    }
    const data = await res.json();
    // 合并而不是整行替换：接口只回用户本体的列，ppt_count / is_guest 得留着
    const merged = { ...row, ...data.user } as AdminUserRow;
    setUsers((prev) => prev.map((u) => (u.id === row.id ? merged : u)));
    setNotice({ tone: 'ok', text: `${done} · ${membershipLabel(merged)}` });
    return true;
  }

  const openDays = (row: AdminUserRow) => {
    setDaysInput('30');
    setDaysFor(row);
  };

  const submitDays = async () => {
    if (!daysFor) return;
    const days = Number(daysInput.trim());
    if (!Number.isInteger(days) || days < 1 || days > GRANT_DAYS_MAX) {
      setNotice({ tone: 'error', text: `天数得是 1 到 ${GRANT_DAYS_MAX} 的整数` });
      return;
    }
    if (await applyGrant(daysFor, { days }, `已开 ${days} 天会员`)) setDaysFor(null);
  };

  const rowMenu = (u: AdminUserRow) => (
    <RowMenu
      width={190}
      items={[
        { kind: 'label', label: membershipLabel(u) },
        { kind: 'action', label: '开 1 年会员', onClick: () => void applyGrant(u, { days: 365 }, '已开 1 年会员') },
        { kind: 'action', label: '设为永久会员', onClick: () => void applyGrant(u, 'permanent', '已设为永久会员') },
        { kind: 'action', label: '自定义天数…', onClick: () => openDays(u) },
        { kind: 'divider' },
        {
          kind: 'action',
          label: '撤销会员…',
          tone: 'danger',
          disabled: !u.pro,
          onClick: () => setRevoking(u),
        },
      ]}
    />
  );

  return (
    <div className="min-h-dvh bg-[#0f0f14] text-[#e0e0e0]">
      <header className="px-6 py-4 flex items-center justify-between border-b border-white/10">
        <div className="flex items-center gap-4">
          <Link href="/admin" className="text-gray-400 hover:text-white">← 返回</Link>
          <div className="text-xl font-bold">会员管理</div>
        </div>
      </header>

      <div className="p-6">
        {notice && <NoticeBar notice={notice} onClose={() => setNotice(null)} />}

        <div className="mb-6 flex flex-wrap items-center gap-3">
          <select
            value={query.tier}
            onChange={(e) => void load({ tier: e.target.value as UserTier, q: query.q, page: 1 })}
            className="px-3 py-2 rounded-lg bg-white/10 border border-white/20 text-sm"
          >
            {TIERS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>

          {/* 搜索：回车或点按钮才查，不在每次按键上打一趟东京 */}
          <form
            className="flex gap-2 flex-1 min-w-[220px]"
            onSubmit={(e) => {
              e.preventDefault();
              void load({ tier: query.tier, q: search.trim(), page: 1 });
            }}
          >
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索邮箱或姓名..."
              className="flex-1 max-w-md px-4 py-2 rounded-lg bg-white/10 border border-white/20 text-sm"
            />
            <button
              type="submit"
              className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 transition text-sm"
            >
              搜索
            </button>
          </form>

          <span className="text-xs text-gray-500">
            共 {total} 人 · 第 {query.page}/{pages} 页
            {busy && ' · 刷新中…'}
          </span>
        </div>

        {users.length === 0 ? (
          <div className="text-center py-20 text-gray-500">
            <div className="text-5xl mb-4">👥</div>
            <p>这一档里没有人</p>
            <p className="text-xs mt-2">
              游客（免登录进来的那批）单独在「游客」档里，默认不掺进注册用户名单。
            </p>
          </div>
        ) : (
          <>
            {/* 桌面表格 */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-gray-400">
                    <th className="text-left py-3 px-4">ID</th>
                    <th className="text-left py-3 px-4">邮箱</th>
                    <th className="text-left py-3 px-4">姓名</th>
                    <th className="text-left py-3 px-4">会员状态</th>
                    <th className="text-left py-3 px-4">PPT</th>
                    <th className="text-left py-3 px-4">注册</th>
                    <th className="text-left py-3 px-4">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => {
                    const label = membershipLabel(u);
                    const tone = TONE[u.membership];
                    return (
                      <tr key={u.id} className="border-b border-white/5 hover:bg-white/5">
                        <td className="py-3 px-4 text-gray-500">{u.id}</td>
                        <td className="py-3 px-4 break-all">{u.email}</td>
                        <td className="py-3 px-4">{u.name}</td>
                        <td className={`py-3 px-4 ${tone}`}>{label}</td>
                        <td className="py-3 px-4 text-gray-300">{u.ppt_count} 份</td>
                        <td className="py-3 px-4 text-gray-400">{u.created_at.slice(0, 10)}</td>
                        {/* 游客行不给授权：那一行没有邮箱也没有密码，接口也会 403 挡回来 */}
                        <td className="py-3 px-4">{u.is_guest ? <span className="text-gray-600">—</span> : rowMenu(u)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* 手机端卡片：七列压成横滚表格在手机上没法读，也没法按 */}
            <div className="md:hidden space-y-3">
              {users.map((u) => {
                const label = membershipLabel(u);
                const tone = TONE[u.membership];
                return (
                  <div key={u.id} className="rounded-lg border border-white/10 bg-white/5 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm" title={u.email}>
                          {u.email}
                        </div>
                        <div className="text-xs text-gray-400 mt-1">
                          #{u.id} · {u.name} · {u.ppt_count} 份 PPT · 注册 {u.created_at.slice(0, 10)}
                        </div>
                      </div>
                      {u.is_guest ? (
                        <span className="text-xs text-gray-500 shrink-0">游客</span>
                      ) : (
                        rowMenu(u)
                      )}
                    </div>
                    <div className={`text-xs mt-2 ${tone}`}>{label}</div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* 分页 */}
        {total > USER_PAGE_SIZE && (
          <div className="mt-6 flex items-center gap-3">
            <button
              onClick={() => void load({ ...query, page: query.page - 1 })}
              disabled={busy || query.page <= 1}
              className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 transition text-sm disabled:opacity-40"
            >
              ← 上一页
            </button>
            <span className="text-xs text-gray-500">
              第 {query.page} / {pages} 页 · 每页 {USER_PAGE_SIZE} 人
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

      {/* 自定义天数 */}
      {daysFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="bg-[#1a1a24] rounded-xl p-6 max-w-md w-full border border-white/10">
            <h2 className="text-lg font-semibold mb-1">给这个人开会员</h2>
            <div className="text-xs text-gray-400 mb-4 break-all">{daysFor.email}</div>

            <label className="text-xs text-gray-400">天数（1 - {GRANT_DAYS_MAX}）</label>
            <input
              type="number"
              value={daysInput}
              min={1}
              max={GRANT_DAYS_MAX}
              onChange={(e) => setDaysInput(e.target.value)}
              className="w-full mt-1 px-3 py-2 rounded-lg bg-white/10 border border-white/20 text-sm"
            />
            <p className="text-xs text-gray-500 mt-2">
              到期时间由服务端按今天往后推，前端传不进任意日期。
            </p>

            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setDaysFor(null)}
                className="flex-1 py-2 rounded-lg bg-white/10 hover:bg-white/20 transition text-sm"
              >
                取消
              </button>
              <button
                onClick={() => void submitDays()}
                className="flex-1 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 transition text-sm font-semibold"
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 撤销会员：降档是会当场少掉功能的那种改动，按两下才动手 */}
      {revoking && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="bg-[#1a1a24] rounded-xl p-6 max-w-md w-full border border-white/10">
            <h2 className="text-lg font-semibold mb-1">撤销这个人的会员？</h2>
            <div className="text-xs text-gray-400 mb-4 break-all">{revoking.email}</div>

            <p className="text-sm leading-relaxed">
              撤销后 {revoking.ppt_count} 份演示文稿还在，但免费版额度立刻生效 ——
              超过额度时他新建或保存会被告知请升级 Pro。
            </p>

            <div className="flex gap-3 mt-6 items-stretch">
              <button
                onClick={() => setRevoking(null)}
                className="flex-1 py-2 rounded-lg bg-white/10 hover:bg-white/20 transition text-sm"
              >
                取消
              </button>
              <ConfirmKey
                label="撤销会员"
                confirmLabel="再点一次就撤销"
                onConfirm={async () => {
                  const row = revoking;
                  setRevoking(null);
                  await applyGrant(row, 'revoke', '已撤销会员');
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
