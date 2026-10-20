import { NextResponse } from 'next/server';
import { getCurrentUserOrGuest } from '@/lib/auth';

export async function GET() {
  const user = await getCurrentUserOrGuest();
  return NextResponse.json({ user });
}
