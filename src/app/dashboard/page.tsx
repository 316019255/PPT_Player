import { getViewerUser } from '@/lib/auth';
import { isAdminEmail } from '@/lib/validate';
import { all } from '@/lib/db';
import DashboardClient from './DashboardClient';

interface Row {
  id: number;
  title: string;
  category_id: number | null;
  slide_count: number;
  created_at: string;
  updated_at: string;
  category_name: string | null;
}

interface CategoryRow {
  id: number;
  name: string;
  ppt_count: number;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ quota?: string }>;
}) {
  // 不建档的身份：解析不出来就是「还没建过档的访客」——他一行数据都没有，
  // 两趟查询直接省掉；真正要建档是第一次保存时那个 Route Handler 的事（那里允许写 cookie）。
  const user = await getViewerUser();

  const { quota } = await searchParams;

  // 页数交给库里的 slide_count() 算：这里曾经 SELECT 出每叠的完整 data 只为了 .length，
  // 一份 29 页的歌稿是 160KB，跨海取回来要 3–10 秒，而列表页根本不需要同步这些内容。
  const [presentations, categories]: [Row[], CategoryRow[]] = user
    ? await Promise.all([
        all<Row>(
          `SELECT p.id, p.title, p.category_id, slide_count(p.data) AS slide_count,
                  p.created_at, p.updated_at, c.name AS category_name
           FROM presentations p LEFT JOIN categories c ON p.category_id = c.id
           WHERE p.user_id = $1 ORDER BY p.updated_at DESC`,
          [user.id]
        ),
        all<CategoryRow>(
          `SELECT c.id, c.name,
                  (SELECT COUNT(*)::int FROM presentations p WHERE p.category_id = c.id) AS ppt_count
           FROM categories c WHERE c.user_id = $1 ORDER BY c.created_at DESC`,
          [user.id]
        ),
      ])
    : [[], []];

  return (
    <DashboardClient
      initialPresentations={presentations}
      initialCategories={categories}
      initialPro={!!user?.pro}
      initialTotalCount={presentations.length}
      quotaNotice={quota === '1'}
      isGuest={!user || !!user.isGuest}
      initialIsAdmin={!!user && isAdminEmail(user.email)}
    />
  );
}
