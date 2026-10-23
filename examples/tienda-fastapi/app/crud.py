from app.models import Pedido


def listar_pedidos(db):
    return db.query(Pedido).all()


def obtener_pedido(db, pedido_id):
    return db.get(Pedido, pedido_id)


def crear_pedido(db, datos, precio):
    pedido = Pedido(cliente_id=datos.cliente_id, producto_id=datos.producto_id, total=precio * datos.cantidad)
    db.add(pedido)
    db.commit()
    db.refresh(pedido)
    return pedido
