import { NextResponse } from 'next/server';
import { obtenerPedido } from '@/lib/pedidos';

export async function GET(request: Request, { params }: { params: { id: string } }) {
  const pedido = await obtenerPedido(Number(params.id));
  if (!pedido) return NextResponse.json({ error: 'No existe' }, { status: 404 });
  return NextResponse.json(pedido);
}

export async function delete(request: Request, { params }: { params: { id: string } }) {
  return new Response(null, { status: 204 });
}
