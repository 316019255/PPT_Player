export default function EditorLoading() {
  return (
    <div className="h-dvh flex flex-col bg-[#0f0f14]">
      <div className="h-14 shrink-0 px-4 flex items-center gap-2 border-b border-white/10">
        <div className="h-8 w-20 rounded-lg bg-white/10 animate-pulse" />
        <div className="h-5 w-40 rounded bg-white/5 animate-pulse" />
        <div className="ml-auto h-8 w-20 rounded-lg bg-white/10 animate-pulse" />
      </div>
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-h-0 p-4">
          <div className="w-full h-full max-w-full aspect-video mx-auto rounded-lg bg-white/5 animate-pulse" />
        </div>
        <div className="hidden md:flex w-72 shrink-0 flex-col gap-3 p-4 border-l border-white/10">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-8 rounded bg-white/5 animate-pulse" />
          ))}
        </div>
      </div>
      <p className="pb-3 text-center text-xs text-gray-500">正在打开编辑器…</p>
    </div>
  );
}
