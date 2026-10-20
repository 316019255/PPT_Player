import { redirect } from 'next/navigation';
import { getAdminUser } from '@/lib/admin';
import Link from 'next/link';

export default async function AdminPage() {
  if (!(await getAdminUser())) {
    redirect('/dashboard');
  }

  return (
    <div className="min-h-dvh bg-[#0f0f14] text-[#e0e0e0]">
      <header className="px-6 py-4 flex items-center justify-between border-b border-white/10">
        <div className="text-xl font-bold">后台管理</div>
        <Link href="/dashboard" className="px-4 py-2 text-sm rounded-lg hover:bg-white/10 transition">
          返回 Dashboard
        </Link>
      </header>

      <main className="p-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-4xl">
          <Link
            href="/admin/materials"
            className="p-6 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 transition"
          >
            <div className="text-4xl mb-3">🖼️</div>
            <div className="text-lg font-semibold mb-2">素材管理</div>
            <div className="text-gray-400 text-sm">前台的在线背景就是这张表：上传到云端桶、粘外链、上下线</div>
          </Link>

          <Link
            href="/admin/users"
            className="p-6 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 transition"
          >
            <div className="text-4xl mb-3">👥</div>
            <div className="text-lg font-semibold mb-2">会员管理</div>
            <div className="text-gray-400 text-sm">开关会员与到期时间，按 会员 / 普通 / 游客 筛选，看每人几份 PPT</div>
          </Link>

          <Link
            href="/admin/decks"
            className="p-6 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 transition"
          >
            <div className="text-4xl mb-3">📑</div>
            <div className="text-lg font-semibold mb-2">PPT 管理</div>
            <div className="text-gray-400 text-sm">
              用户建的稿子：按标题 / 作者 / 分类检索，只读预览、改名、移分类、删除
            </div>
          </Link>
        </div>
      </main>
    </div>
  );
}
