import { unstable_cache } from 'next/cache';
import { all } from './db';
import { isCloudPath } from './media-source';

/**
 * 前台可选的在线背景。materials 表是这里的唯一真相：管理员改一条，编辑器就跟着变。
 * 所以 DB 读不出来时返回空数组 + 明确提示，不回退任何写死的清单 —— 留第二份真相
 * 只会让「后台改了前台不动」这类问题永远查不清。
 */
export interface LibraryMaterial {
  id: number;
  kind: 'image' | 'video';
  title: string;
  category: string;
  /** 选中之后进 deck 的值：外链是完整 URL，桶内是 u{id}/… 或 lib/… 路径 */
  ref: string;
  thumb: string;
  /** true = ref 是存储桶内路径，渲染时要拿公开前缀拼 URL，deck 里绝不存域名 */
  cloud: boolean;
}

interface MaterialRow {
  id: number;
  kind: 'image' | 'video';
  title: string;
  category: string;
  url: string;
  thumb_url: string | null;
}

// 只带前台要用的字段：这份数据会进 RSC payload，24 条 × 全列是白送的几百字节
const ENABLED_SQL = `
  SELECT id, kind, title, category, url, thumb_url
  FROM materials
  WHERE enabled = 1
  ORDER BY sort DESC, id ASC
`;

async function loadEnabledMaterials(): Promise<LibraryMaterial[]> {
  try {
    const rows = await all<MaterialRow>(ENABLED_SQL);
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title || '未命名素材',
      category: r.category || '未分类',
      ref: r.url,
      thumb: r.thumb_url || r.url,
      cloud: isCloudPath(r.url),
    }));
  } catch (error) {
    console.error('[materials] 在线素材读取失败，前台按「暂无素材」降级：', error instanceof Error ? error.message : error);
    return [];
  }
}

/**
 * 5 分钟重新查一次：素材列表几乎不变，而编辑器每打开一次都要读它，
 * 直查等于每个编辑动作之前先付一趟跨海往返（实测东京 180ms）。
 * 后台任何写操作都调 revalidateTag('materials')，所以管理员的改动不必等这 5 分钟。
 */
export const getOnlineMaterials = unstable_cache(loadEnabledMaterials, ['materials', 'online'], {
  revalidate: 300,
  tags: ['materials'],
});
