import { NextRequest, NextResponse } from 'next/server';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { Readable } from 'stream';
import path from 'path';

export const runtime = 'nodejs';

const UPLOADS_DIR = path.join(process.cwd(), 'public', 'uploads');

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.ogg': 'audio/ogg',
  '.mov': 'video/quicktime',
};

/** 旧的服务端导入落盘用的名字：up_<base36 时间戳>_<12 位十六进制><白名单扩展名> */
const STORED_NAME = /^up_[0-9a-z]+_[0-9a-f]{12}(\.[a-z0-9]{2,5})$/;

function notFound() {
  return new NextResponse('未找到', { status: 404 });
}

/**
 * 只服务旧服务端导入留在 public/uploads 里的历史素材：导入搬进浏览器之后，这里不再有新文件写入。
 * next start 只对外提供构建当时就存在于 public 里的文件，运行时新写入的必须经这条路由。
 * 支持 Range，视频才能拖动进度条。
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  if (!STORED_NAME.test(name)) return notFound();
  const type = MIME_BY_EXT[path.extname(name).toLowerCase()];
  if (!type) return notFound();

  const filePath = path.join(UPLOADS_DIR, name);
  const info = await stat(filePath).catch(() => null);
  if (!info || !info.isFile()) return notFound();

  let start = 0;
  let end = info.size - 1;
  let status = 200;

  const range = req.headers.get('range');
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match) {
      const from = match[1] ? Number(match[1]) : null;
      const to = match[2] ? Number(match[2]) : null;
      if (from !== null && Number.isFinite(from)) {
        start = from;
        end = to !== null && Number.isFinite(to) ? Math.min(to, info.size - 1) : info.size - 1;
      } else if (to !== null && Number.isFinite(to) && to > 0) {
        start = Math.max(0, info.size - to);
      }
      if (start >= info.size || start > end) {
        return new NextResponse('范围无效', {
          status: 416,
          headers: { 'Content-Range': `bytes */${info.size}` },
        });
      }
      status = 206;
    }
  }

  const length = end - start + 1;
  const headers = new Headers({
    'Content-Type': type,
    'Content-Length': String(length),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
  if (status === 206) headers.set('Content-Range', `bytes ${start}-${end}/${info.size}`);

  return new NextResponse(Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream, {
    status,
    headers,
  });
}
