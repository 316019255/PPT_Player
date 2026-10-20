import { NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { readJsonBody, requireAdmin } from '@/lib/admin';
import { MATERIAL_COLS, listMaterials, type MaterialRow } from '@/lib/admin-data';
import { deleteCloudObject } from '@/lib/media-store';
import { isLibraryCloudPath } from '@/lib/media-source';
import { get, run } from '@/lib/db';

/**
 * 素材一改，前台那份缓存就当场作废。
 * Next 16 起第二个参数必填（单参数写法已废弃，控制台会刷警告）；'max' 那档是
 * 「先回旧数据、后台重新取」，管理员下线一条之后前台还会照旧看到它 —— 这里要的是立刻。
 */
const EXPIRE_NOW = { expire: 0 };

export async function GET(request: Request) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  const { searchParams } = new URL(request.url);
  const materials = await listMaterials({
    kind: searchParams.get('kind') ?? undefined,
    category: searchParams.get('category') ?? undefined,
  });
  return NextResponse.json({ materials });
}

/** 从请求体里取字符串：不是字符串就当没有，顺手截到上限 */
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * 只认整数和纯数字字符串（<input type=number> 交出来的就是字符串），
 * 最多九位带上符号：Number(true)=1、Number(null)=0、Number([])=0 这种"看起来是整数"的强转一律拒。
 */
function intOf(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string' && /^[+-]?\d{1,9}$/.test(v.trim())) return Number(v.trim());
  return null;
}

/** 前台格子显示的是 title，alt 只当无障碍文案；两边都不能无限长 */
const TITLE_MAX = 100;
const CATEGORY_MAX = 50;

export async function POST(request: Request) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  const body = await readJsonBody(request);
  if (body instanceof NextResponse) return body;

  const url = str(body.url, 2048);
  const kind = str(body.kind, 10);
  if (!kind || !url) {
    return NextResponse.json({ error: '缺少 kind 或 url' }, { status: 400 });
  }
  if (kind !== 'image' && kind !== 'video') {
    return NextResponse.json({ error: 'kind 必须是 image 或 video' }, { status: 400 });
  }
  const sort = body.sort === undefined ? 0 : intOf(body.sort);
  if (sort === null) {
    return NextResponse.json({ error: 'sort 必须是整数' }, { status: 400 });
  }

  try {
    // url 上有唯一索引：同一条素材重复录入不该插出第二份，也不该被 pg 顶成 500。
    // 这里不能用 insert()，它假定 RETURNING 必定回一行；DO NOTHING 撞车时是没有行。
    const row = await get<{ id: number }>(
      `INSERT INTO materials (kind, url, thumb_url, category, tags, alt, title, sort)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (url) DO NOTHING
       RETURNING id`,
      [
        kind,
        url,
        str(body.thumb_url, 2048) || null,
        str(body.category, CATEGORY_MAX) || '未分类',
        str(body.tags, 500) || null,
        str(body.alt, 200) || null,
        str(body.title, TITLE_MAX),
        sort,
      ]
    );

    if (!row) {
      return NextResponse.json({ error: '这个地址已经在素材库里了' }, { status: 409 });
    }

    revalidateTag('materials', EXPIRE_NOW);
    return NextResponse.json({ id: row.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : '创建失败';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** 改一条素材：只认 title / category / sort / enabled 四个字段，其余一律不动 */
export async function PATCH(request: Request) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  const body = await readJsonBody(request);
  if (body instanceof NextResponse) return body;

  const { id } = body;
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: '缺少有效的 id' }, { status: 400 });
  }

  const sets: string[] = [];
  const params: (string | number)[] = [];
  const add = (col: string, val: string | number) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };

  if (body.title !== undefined) add('title', str(body.title, TITLE_MAX));
  if (body.category !== undefined) add('category', str(body.category, CATEGORY_MAX) || '未分类');
  if (body.sort !== undefined) {
    const sort = intOf(body.sort);
    if (sort === null) return NextResponse.json({ error: 'sort 必须是整数' }, { status: 400 });
    add('sort', sort);
  }
  if (body.enabled !== undefined) {
    if (body.enabled !== 0 && body.enabled !== 1) {
      return NextResponse.json({ error: 'enabled 只能是 0 或 1' }, { status: 400 });
    }
    add('enabled', body.enabled);
  }
  if (!sets.length) {
    return NextResponse.json({ error: '没有要修改的字段' }, { status: 400 });
  }

  params.push(id);

  try {
    // 回读进这条语句：改完立刻拿到新行，前端不必再查一遍（东京一趟往返实测 180ms）
    const updated = await get<MaterialRow>(
      `UPDATE materials SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING ${MATERIAL_COLS}`,
      params
    );
    if (!updated) {
      return NextResponse.json({ error: '找不到这条素材' }, { status: 404 });
    }

    revalidateTag('materials', EXPIRE_NOW);
    return NextResponse.json({ material: updated });
  } catch (error) {
    const message = error instanceof Error ? error.message : '更新失败';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * 删一条素材。默认只删记录 —— 前台立刻看不见，已经引用它的稿子照常放映。
 * file=1 才连带删桶里的字节，那是不可逆的：稿子的背景会渲染不出来，而稿子本身不会报错。
 * 所以勾这一项由前端二阶确认负责，这里只保证一件事 —— 只有 lib/ 目录删得动（写在
 * deleteCloudObject 的能力上），外链素材和用户上传的 u{id}/ 对象都从这条路走不通。
 */
export async function DELETE(request: Request) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  const { searchParams } = new URL(request.url);
  const numId = Number(searchParams.get('id'));
  if (!Number.isInteger(numId) || numId <= 0) {
    return NextResponse.json({ error: '缺少有效的 id' }, { status: 400 });
  }
  const purge = searchParams.get('file') === '1';

  // 先拿到对象名再删记录：删完就查不到 url 了，而桶那一边只认路径
  const target = purge
    ? await get<{ url: string; thumb_url: string | null }>(
        'SELECT url, thumb_url FROM materials WHERE id = $1',
        [numId]
      )
    : null;

  const removed = await run('DELETE FROM materials WHERE id = $1', [numId]);
  if (!removed.changes) {
    return NextResponse.json({ error: '找不到这条素材' }, { status: 404 });
  }
  revalidateTag('materials', EXPIRE_NOW);

  // 记录先落地，文件后动手：反过来的话文件删失败会留下「前台还在用这条素材」而管理员以为删干净了；
  // 现在最坏只是桶里多一个没人引用的对象，重新传同一份内容会命中去重，不会再占一份空间。
  const failures: string[] = [];
  if (purge && target) {
    for (const path of [target.url, target.thumb_url]) {
      if (!path || !isLibraryCloudPath(path)) continue;
      const result = await deleteCloudObject(path);
      if (result.kind === 'error') failures.push(`${path}：${result.reason}`);
    }
  }

  return NextResponse.json({ success: true, purged: purge, failures });
}
