# Tienda FastAPI (ejemplo para Spectator)

Backend FastAPI pequeño escrito como lo haría una IA con prisa, con errores típicos a propósito: ruta duplicada,
`requests` dentro de un endpoint `async`, cuerpo sin validar (`dict`), modelo de base de datos devuelto sin
`response_model` y un modelo Pydantic que no se usa.
