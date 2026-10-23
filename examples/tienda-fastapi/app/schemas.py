from pydantic import BaseModel, Field


class PedidoCreate(BaseModel):
    cliente_id: int
    producto_id: int
    cantidad: int = Field(gt=0)


class PedidoOut(BaseModel):
    id: int
    total: float


class CuponIn(BaseModel):
    codigo: str
    porcentaje: int = Field(ge=1, le=90)
