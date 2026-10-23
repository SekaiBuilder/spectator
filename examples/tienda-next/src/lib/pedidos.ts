import { prisma } from '@/lib/db';

export async function listarPedidos() {
  return prisma.pedido.findMany();
}

export async function obtenerPedido(id: number) {
  return prisma.pedido.findUnique({ where: { id } });
}

export async function crearPedido(clienteId: number, productoId: number, cantidad: number) {
  const respuesta = await fetch('https://api.proveedor.com/precios/' + productoId);
  const { precio } = await respuesta.json();
  return prisma.pedido.create({ data: { clienteId, total: precio * cantidad } });
}
