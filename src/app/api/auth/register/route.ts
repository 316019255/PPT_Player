import { NextResponse } from 'next/server';
import { registerUser, signToken, setAuthCookie } from '@/lib/auth';

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { email?: string; password?: string; name?: string };
    const { email, password, name } = body;

    if (!email || !password || !name) {
      return NextResponse.json({ error: '请填写完整信息' }, { status: 400 });
    }

    const user = await registerUser(email, password, name);
    const token = signToken(user);
    await setAuthCookie(token);

    return NextResponse.json({ user });
  } catch (error) {
    const message = error instanceof Error ? error.message : '注册失败';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
