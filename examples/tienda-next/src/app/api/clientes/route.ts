import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function POST(req: any) {
  const { nombre } = req.body;
  const cliente = await prisma.cliente.create({ data: { nombre } });
  return NextResponse.json(cliente, { status: 201 });
}
