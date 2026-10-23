# tienda-django

Backend pequeño en Django REST Framework escrito «como una IA con prisa», con respuestas conocidas para comprobar el mapa del backend de Spectator. No hace falta instalarlo: Spectator lo lee sin ejecutarlo.

Errores sembrados (los comentarios del código los marcan):

- `views.informe_ventas` no existe: Django no arranca.
- `crear_pedido` guarda sin llamar a `is_valid()`: responde 500.
- `cliente_detalle` usa `.get()`: si el cliente no existe, responde 500 en vez de 404.
- `ClienteSerializer` usa `fields = "__all__"`: la contraseña sale en la respuesta.
- `webhook_pago` desactiva CSRF y usa el cuerpo sin validar.
- `ResumenVentasSerializer` no se usa.
- `DEBUG = True` con `ALLOWED_HOSTS = ["*"]`.
