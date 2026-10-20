export default function PlayLoading() {
  return (
    <div className="h-dvh w-full flex flex-col items-center justify-center gap-3 bg-black">
      <div className="w-40 aspect-video rounded-lg bg-white/5 animate-pulse" />
      <p className="text-xs text-gray-500">正在准备放映…</p>
    </div>
  );
}
