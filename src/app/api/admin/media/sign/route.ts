import { NextResponse } from 'next/server';
import { readJsonBody, requireAdmin } from '@/lib/admin';
import { createUploadLink } from '@/lib/media-store';
import { libraryCloudPath } from '@/lib/media-source';
import { readUploadRequest } from '@/lib/upload-request';

/**
 * 管理员素材库的上传签发，和用户那一头的 /api/media/sign 走同一条链路：
 * 浏览器算指纹 → 这里签一个绑死单条路径的一次性地址 → 字节直传桶，不占应用服务器的函数体上限。
 *
 * 区别只有目录：素材全站共用，所以落在 lib/ 而不是某个人的 u{id}/ 下。
 * 谁能调这个接口由 requireAdmin 决定 —— 素材库是全站可见的内容，
 * 让任意登录用户往里塞对象等于把本站域名变成图床。
 */
export async function POST(request: Request) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  const body = await readJsonBody(request);
  if (body instanceof NextResponse) return body;

  const req = readUploadRequest(body);
  if (!req.ok) return NextResponse.json({ error: req.error }, { status: req.status });

  const path = libraryCloudPath(req.sha256, req.ext);
  if (!path) return NextResponse.json({ error: '存储路径不合法' }, { status: 400 });

  const link = await createUploadLink(path);
  if (link.kind === 'error') {
    return NextResponse.json({ error: link.reason }, { status: 502 });
  }
  if (link.kind === 'exists') {
    return NextResponse.json({ path, mime: req.mime, reused: true });
  }
  return NextResponse.json({
    path,
    mime: req.mime,
    uploadUrl: link.url,
    token: link.token,
    reused: false,
  });
}
