import requests


def precio_proveedor(producto_id):
    respuesta = requests.get("https://api.proveedor.com/precio", params={"id": producto_id}, timeout=5)
    return respuesta.json()["precio"]
