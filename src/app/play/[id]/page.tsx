import { notFound } from 'next/navigation';
import { getViewerUser } from '@/lib/auth';
import { get } from '@/lib/db';
import { readStoredSlides } from '@/lib/slide-data';
import PlayerClient from './PlayerClient';

interface PresentationRow {
  id: number;
  title: string;
  data: string;
}

export default async function PlayPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ slide?: string }>;
}) {
  // 放映只需要「这份稿子是不是这个人的」，不需要额度 —— 所以走不建档的那条身份路径。
  // 没登录也没游客档的人按 id 必然查不到内容，直接 404，省掉一次 SELECT + 一次 INSERT。
  const user = await getViewerUser();
  if (!user) notFound();

  const { id } = await params;
  const { slide } = await searchParams;

  const row = await get<PresentationRow>(
    'SELECT id, title, data FROM presentations WHERE id = $1 AND user_id = $2',
    [Number(id), user.id]
  );

  if (!row) notFound();

  const slides = readStoredSlides(row.data);
  if (slides.length === 0) notFound();

  // URL 里给的是 1-based
  const startSlide = slide ? Math.max(0, Number(slide) - 1) : 0;

  return (
    <PlayerClient
      presentationId={row.id}
      title={row.title}
      slides={slides}
      startSlide={Math.min(startSlide, slides.length - 1)}
    />
  );
}
