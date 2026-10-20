import { NextResponse } from 'next/server';
import { loginUser, signToken, setAuthCookie } from '@/lib/auth';

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { email?: string; password?: string };
    const { email, password } = body;

    if (!email || !password) {
      return NextResponse.json({ error: '请填写邮箱和密码' }, { status: 400 });
    }

    const user = await loginUser(email, password);
    const token = signToken(user);
    await setAuthCookie(token);

    return NextResponse.json({ user });
  } catch (error) {
    const message = error instanceof Error ? error.message : '登录失败';
    return NextResponse.json({ error: message }, { status: 401 });
  }
}
