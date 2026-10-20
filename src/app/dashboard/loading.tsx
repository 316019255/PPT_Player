// 列表页的数据要从东京的 Postgres 取（实测一跳 ~180ms，冷连接 1.3–3.9s）。
// 没有这一层时，点了链接以后浏览器整页不动，看着就像卡死；有骨架才能立刻反馈「在加载」。
// 骨架的形状要贴着真实页面：手机端是顶栏 + 一行分类 chips + 单列卡片，桌面端是侧栏 + 标题 + 多列卡片。
// 写歪一截，每天加载时第一屏就会跳一下。
export default function DashboardLoading() {
  return (
    <div className="min-h-dvh md:h-dvh flex flex-col md:flex-row bg-[#0f0f14]">
      {/* 手机端顶栏：☰ + 标题 + 新建 */}
      <div className="md:hidden h-14 px-3 flex items-center gap-2 border-b border-white/10">
        <div className="w-11 h-11 shrink-0 rounded-lg bg-white/10 animate-pulse" />
        <div className="h-5 flex-1 max-w-40 rounded bg-white/10 animate-pulse" />
        <div className="ml-auto h-11 w-20 shrink-0 rounded-lg bg-white/10 animate-pulse" />
      </div>

      {/* 桌面侧栏 */}
      <div className="hidden md:flex w-56 shrink-0 flex-col gap-3 p-4 border-r border-white/10 bg-[#111119]">
        <div className="h-6 w-32 rounded bg-white/10 animate-pulse" />
        <div className="h-20 rounded-lg bg-white/5 animate-pulse" />
        <div className="h-9 rounded-lg bg-white/5 animate-pulse" />
        <div className="h-9 rounded-lg bg-white/5 animate-pulse" />
      </div>

      <div className="flex-1 md:overflow-y-auto px-3 pb-8 pt-4 md:p-8">
        {/* 手机端分类 chips：父层已给 px-3，这里三根就够铺满一屏，多出来会被裁成一截假条 */}
        <div className="md:hidden pb-1 flex gap-1.5">
          {[96, 84, 110].map((w, i) => (
            <div key={i} className="h-11 shrink-0 rounded-lg bg-white/5 animate-pulse" style={{ width: w }} />
          ))}
        </div>

        {/* 桌面端标题区 */}
        <div className="hidden md:block mb-6 space-y-2">
          <div className="h-9 w-64 rounded bg-white/10 animate-pulse" />
          <div className="h-4 w-28 rounded bg-white/5 animate-pulse" />
        </div>

        <div className="mt-4 md:mt-0 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-white/10 bg-white/5 p-4">
              <div className="h-5 w-2/3 rounded bg-white/10 animate-pulse" />
              <div className="mt-2 h-3 w-1/3 rounded bg-white/5 animate-pulse" />
              <div className="mt-4 flex gap-2">
                {[0, 1, 2].map((k) => (
                  <div key={k} className="flex-1 h-11 rounded-lg bg-white/5 animate-pulse" />
                ))}
              </div>
            </div>
          ))}
        </div>

        <p className="mt-6 text-center text-xs text-gray-500">正在读取你的演示文稿…</p>
      </div>
    </div>
  );
}
