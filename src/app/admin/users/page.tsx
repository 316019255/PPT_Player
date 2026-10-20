import { redirect } from 'next/navigation';
import { getAdminUser } from '@/lib/admin';
import { listUsers } from '@/lib/admin-data';
import UsersClient from './UsersClient';

/** 首屏在服务组件里查一次，视图不再用 useEffect 拉列表（见素材页同样的理由） */
export default async function AdminUsersPage() {
  if (!(await getAdminUser())) {
    redirect('/dashboard');
  }

  // 「已过期 / 至某日」在 listUsers 那一层按服务端时钟算好带上：
  // 组件里读时间会撞 react-hooks/purity，服务端和浏览器还会各算各的
  const { rows, total } = await listUsers();

  return <UsersClient initialUsers={rows} initialTotal={total} />;
}
