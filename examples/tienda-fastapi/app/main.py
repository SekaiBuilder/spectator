from fastapi import FastAPI

from app.routers import clientes, pedidos

app = FastAPI(title="Tienda")
app.include_router(pedidos.router, prefix="/api")
app.include_router(clientes.router, prefix="/api")
