import { notFound } from 'next/navigation';
import { getViewerUser } from '@/lib/auth';
import { get } from '@/lib/db';
import { getOnlineMaterials } from '@/lib/materialLibrary';
import { readStoredSlides } from '@/lib/slide-data';
import { FREE_PPT_LIMIT } from '@/types/ppt';
import EditorClient from './EditorClient';

interface PresentationRow {
  id: number;
  title: string;
  data: string;
}

export default async function EditorPage({ params }: { params: Promise<{ id: string }> }) {
  // 不建档：首次访客在这里只是「还没有档可查」，不是「现在给他建一行」。
  // 渲染里写 cookie 会被 Next 拒掉（抛错崩页），而建那一行又已经落库 —— 于是每刷一次
  // 就多一次崩页 + 多一行没人认领的游客档。建档交给第一次保存的 Route Handler。
  const user = await getViewerUser();

  const { id } = await params;

  // 只有新建那一路要数额度：EditorClient 里的 overQuota 只在没有 activeId 时才读 initialCount，
  // 打开已有的稿子再数一遍 COUNT 是白付一趟往返（实测东京 190ms）。
  if (id === 'new') {
    const [count, materials] = await Promise.all([
      // Postgres 的 COUNT 是 bigint，不 ::int 会以字符串返回
      user
        ? get<{ c: number }>('SELECT COUNT(*)::int AS c FROM presentations WHERE user_id = $1', [
            user.id,
          ]).then((r) => r?.c ?? 0)
        : Promise.resolve(0),
      getOnlineMaterials(),
    ]);

    // 免费额度只剩一次机会时，别让新建页把额度用光后卡在编辑器里
    if (!user?.pro && count >= FREE_PPT_LIMIT) notFound();
    return (
      <EditorClient
        presentationId={null}
        initialTitle="未命名演示文稿"
        initialData={null}
        initialPro={!!user?.pro}
        initialCount={count}
        materials={materials}
      />
    );
  }

  if (!user) notFound();

  const [row, materials] = await Promise.all([
    get<PresentationRow>('SELECT id, title, data FROM presentations WHERE id = $1 AND user_id = $2', [
      Number(id),
      user.id,
    ]),
    getOnlineMaterials(),
  ]);

  if (!row) notFound();

  return (
    <EditorClient
      presentationId={row.id}
      initialTitle={row.title}
      initialData={readStoredSlides(row.data)}
      initialPro={!!user.pro}
      initialCount={0}
      materials={materials}
    />
  );
}
