import { redirect } from 'next/navigation';
import { getAdminUser } from '@/lib/admin';
import { listDecks } from '@/lib/admin-data';
import DecksClient from './DecksClient';

/** 首屏在服务组件里查一次，视图不再用 useEffect 拉列表（见素材页、用户页同样的理由） */
export default async function AdminDecksPage() {
  if (!(await getAdminUser())) {
    redirect('/dashboard');
  }

  const { rows, total } = await listDecks();

  return <DecksClient initialDecks={rows} initialTotal={total} />;
}
