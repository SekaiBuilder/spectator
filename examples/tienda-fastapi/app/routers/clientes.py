from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Cliente

router = APIRouter(prefix="/clientes")


@router.get("/{cliente_id}")
def obtener_cliente(cliente_id: int, db: Session = Depends(get_db)) -> Cliente:
    return db.query(Cliente).get(cliente_id)
