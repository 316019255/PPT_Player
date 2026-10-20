import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="min-h-dvh flex flex-col">
      {/* 顶部导航 */}
      <header className="px-6 py-4 flex items-center justify-between border-b border-white/10">
        <div className="text-xl font-bold"> PPT 播放器</div>
        <div className="flex gap-3">
          <a href="/login" className="px-4 py-2 text-sm rounded-lg hover:bg-white/10 transition">
            登录
          </a>
          <a
            href="/register"
            className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 transition"
          >
            免费注册
          </a>
        </div>
      </header>

      {/* Hero 区域 */}
      <main className="flex-1 flex flex-col items-center justify-center px-6 py-16">
        <div className="text-center max-w-3xl">
          <h1 className="text-5xl md:text-6xl font-bold mb-6 bg-gradient-to-r from-blue-400 via-purple-400 to-pink-400 bg-clip-text text-transparent">
            在线 PPT 大屏播放器
          </h1>
          <p className="text-xl text-gray-400 mb-8">
            创建、编辑、全屏播放 — 支持图片视频背景、自定义字体样式，适合会议演示、歌词展示、活动大屏
          </p>
          <Link
            href="/editor/new"
            className="inline-block px-8 py-4 rounded-lg bg-blue-600 hover:bg-blue-700 transition font-semibold text-lg"
          >
            新建在线 PPT
          </Link>
        </div>

        {/* 功能卡片 */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-20 max-w-5xl w-full">
          {[
            { icon: '', title: '自由编辑', desc: '添加幻灯片、文字块，调整字体大小和颜色' },
            { icon: '️', title: '在线背景', desc: '精选图片和视频资源一键设为背景' },
            { icon: '', title: '大屏全屏', desc: '一键全屏/退出，键盘方向键翻页' },
          ].map((f) => (
            <div
              key={f.title}
              className="p-6 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 transition"
            >
              <div className="text-4xl mb-3">{f.icon}</div>
              <div className="text-lg font-semibold mb-2">{f.title}</div>
              <div className="text-gray-400 text-sm">{f.desc}</div>
            </div>
          ))}
        </div>
      </main>

      {/* 底部 */}
      <footer className="px-6 py-6 text-center text-gray-500 text-sm border-t border-white/5">
        PPT Player — 在线大屏演示解决方案
      </footer>
    </div>
  );
}
