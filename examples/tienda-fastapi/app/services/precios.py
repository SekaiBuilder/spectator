import requests


def obtener_precio(producto_id):
    respuesta = requests.get("https://api.proveedor.com/precios/" + str(producto_id))
    return respuesta.json()["precio"]
