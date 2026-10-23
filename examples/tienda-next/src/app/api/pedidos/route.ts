import { NextResponse } from 'next/server';
import { z } from 'zod';
import { crearPedido, listarPedidos } from '@/lib/pedidos';

const NuevoPedido = z.object({ clienteId: z.number(), productoId: z.number(), cantidad: z.number().min(1) });

export async function GET() {
  const pedidos = await listarPedidos();
  return NextResponse.json(pedidos);
}

export async function POST(request: Request) {
  const { clienteId, productoId, cantidad } = NuevoPedido.parse(await request.json());
  const pedido = await crearPedido(clienteId, productoId, cantidad);
  return NextResponse.json(pedido, { status: 201 });
}
