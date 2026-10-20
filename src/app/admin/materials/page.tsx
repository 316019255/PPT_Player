import { redirect } from 'next/navigation';
import { getAdminUser } from '@/lib/admin';
import { listMaterialCategories, listMaterials } from '@/lib/admin-data';
import MaterialsClient from './MaterialsClient';

/**
 * 首屏数据在这里查：客户端组件如果靠 useEffect 拉列表，
 * 就是 lint 的 set-state-in-effect（挂载即二次渲染），而且白屏多等一趟往返。
 * 之后的筛选/新增/删除仍由视图自己调 /api/admin/materials 重查。
 */
export default async function AdminMaterialsPage() {
  if (!(await getAdminUser())) {
    redirect('/dashboard');
  }

  const [materials, categories] = await Promise.all([
    listMaterials(),
    listMaterialCategories(),
  ]);

  return (
    <MaterialsClient initialMaterials={materials} initialCategories={categories} />
  );
}
