from django.urls import include, path
from rest_framework.routers import DefaultRouter

from . import views

router = DefaultRouter()
router.register(r"productos", views.ProductoViewSet)

urlpatterns = [
    path("clientes/", views.clientes),
    path("clientes/<int:pk>/", views.cliente_detalle),
    path("pedidos/", views.crear_pedido),
    path("pedidos/<int:pk>/", views.borrar_pedido),
    path("pedidos/lista/", views.PedidoLista.as_view()),
    path("pagos/webhook/", views.webhook_pago),
    # Error sembrado: la vista no existe; Django no arranca.
    path("informes/", views.informe_ventas),
    path("", include(router.urls)),
]
