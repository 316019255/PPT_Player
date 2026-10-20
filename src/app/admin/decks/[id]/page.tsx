import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { getAdminUser } from '@/lib/admin';
import { getDeckForAdmin } from '@/lib/admin-data';
import { readStoredSlides } from '@/lib/slide-data';
import PlayerClient from '@/app/play/[id]/PlayerClient';

/**
 * 后台的只读预览：放的是**别人**的稿子。
 * 除了「按 id 取、不带 user_id」，它和用户侧 /play/[id] 用的是同一个 PlayerClient ——
 * 再写一个播放器就等着两边渲染漂移。
 */
export default async function AdminDeckPreviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!(await getAdminUser())) {
    redirect('/dashboard');
  }

  const { id } = await params;
  const deckId = Number(id);
  if (!Number.isInteger(deckId) || deckId <= 0) notFound();

  const deck = await getDeckForAdmin(deckId);
  if (!deck) notFound();

  const slides = readStoredSlides(deck.data);
  // 库里读得出这一行、却一页都渲染不出来（data 是空数组或坏 JSON）。
  // 这里不给 404：列表明明写着这份稿子，404 只会让人以为是列表在骗人。
  if (slides.length === 0) {
    return (
      <div className="min-h-dvh bg-[#0f0f14] text-[#e0e0e0]">
        <header className="px-6 py-4 flex items-center gap-4 border-b border-white/10">
          <Link href="/admin/decks" className="text-gray-400 hover:text-white">← 返回列表</Link>
          <div className="text-lg font-bold truncate">{deck.title}</div>
        </header>
        <main className="p-6 text-sm text-gray-400 leading-relaxed">
          <p>
            这份稿子一页都没有 —— 它的 <code>data</code> 是空的或不是合法的 JSON，所以没东西可放。
          </p>
          <p className="mt-2">
            #{deck.id} · {deck.name}·{deck.email} · 建 {deck.created_at.slice(0, 10)} ·
            更新 {deck.updated_at.slice(0, 10)} · {Buffer.byteLength(deck.data, 'utf8')} 字节
          </p>
          <p className="mt-2 text-gray-500">
            列表里那种稿子会显示「0 页」，就是同一个原因，不是列表数错了。
          </p>
        </main>
      </div>
    );
  }

  return (
    <PlayerClient
      presentationId={deck.id}
      title={`${deck.title} · 后台预览 · ${deck.email}`}
      slides={slides}
      backHref="/admin/decks"
      readOnly
    />
  );
}
