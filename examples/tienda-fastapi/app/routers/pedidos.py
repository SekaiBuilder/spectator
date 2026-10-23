from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import crud
from app.database import get_db
from app.schemas import PedidoCreate, PedidoOut
from app.services.precios import obtener_precio

router = APIRouter(prefix="/pedidos", tags=["pedidos"])


@router.get("/", response_model=list[PedidoOut])
def listar(db: Session = Depends(get_db)):
    return crud.listar_pedidos(db)


@router.get("/{pedido_id}", response_model=PedidoOut)
def obtener(pedido_id: int, db: Session = Depends(get_db)):
    pedido = crud.obtener_pedido(db, pedido_id)
    if pedido is None:
        raise HTTPException(status_code=404, detail="El pedido no existe")
    return pedido


@router.post("/", response_model=PedidoOut, status_code=201)
async def crear(pedido: PedidoCreate, db: Session = Depends(get_db)):
    precio = obtener_precio(pedido.producto_id)
    return crud.crear_pedido(db, pedido, precio)


@router.get("/{pedido_id}")
def obtener_detalle(pedido_id: int, db: Session = Depends(get_db)):
    return crud.obtener_pedido(db, pedido_id)


@router.post("/descuento")
def aplicar_descuento(datos: dict):
    return {"aplicado": datos.get("codigo")}
