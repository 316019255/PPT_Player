import { NextResponse } from 'next/server';
import { getCurrentUserOrGuest } from '@/lib/auth';
import { createUploadLink } from '@/lib/media-store';
import { cloudPath } from '@/lib/media-source';
import { readUploadRequest } from '@/lib/upload-request';

/**
 * 申请一个上传地址。字节不经过这里（Vercel 函数请求体约 4.5MB，一张课件图就能超），
 * 浏览器拿到地址后直传桶，所以这个路由只做三件事：
 * 确认登录、把路径钉死在申请人自己的目录里、签一个一次性地址。
 *
 * 文件形状（指纹、媒体类型、大小上限）判在 upload-request.ts，
 * 和后台素材库的签发入口共用同一份 —— 两边判得不一样时，宽松那头发出去的字节
 * 会在存盘时被 deck 校验器判成「没有素材」，用户看到的就是「传成功了但显示不出来」。
 *
 * 路径里的 userId 只来自登录态，绝不采信请求里带的任何 id ——
 * 否则任何人都能往别人的目录里塞文件。
 */
export async function POST(request: Request) {
  const user = await getCurrentUserOrGuest();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体不是合法的 JSON' }, { status: 400 });
  }

  const req = readUploadRequest(body);
  if (!req.ok) return NextResponse.json({ error: req.error }, { status: req.status });

  const path = cloudPath(user.id, req.sha256, req.ext);
  if (!path) return NextResponse.json({ error: '存储路径不合法' }, { status: 400 });

  const link = await createUploadLink(path);
  if (link.kind === 'error') {
    return NextResponse.json({ error: link.reason }, { status: 502 });
  }
  // 桶里已有同样内容：不用重传，浏览器直接把这个路径当已就绪的用
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
