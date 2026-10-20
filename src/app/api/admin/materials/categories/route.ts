import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin';
import { listMaterialCategories } from '@/lib/admin-data';

export async function GET() {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  return NextResponse.json({ categories: await listMaterialCategories() });
}
