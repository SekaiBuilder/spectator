'use client';

export function Carrito() {
  const clave = process.env.STRIPE_SECRET_KEY;
  const publica = process.env.NEXT_PUBLIC_TIENDA;
  return <div>{publica} {clave ? 'ok' : 'sin clave'}</div>;
}
