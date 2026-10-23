import json

from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from django.views.decorators.csrf import csrf_exempt
from rest_framework import generics, status, viewsets
from rest_framework.decorators import action, api_view
from rest_framework.response import Response

from . import services
from .models import Cliente, Pedido, Producto
from .serializers import ClienteSerializer, PedidoSerializer, ProductoSerializer


class ProductoViewSet(viewsets.ModelViewSet):
    queryset = Producto.objects.all()
    serializer_class = ProductoSerializer

    @action(detail=True, methods=["get"])
    def precio(self, request, pk=None):
        producto = self.get_object()
        return Response({"precio": services.precio_proveedor(producto.id)})


@api_view(["GET", "POST"])
def clientes(request):
    if request.method == "POST":
        serializer = ClienteSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data, status=status.HTTP_201_CREATED)
    buscar = request.query_params.get("buscar", "")
    lista = Cliente.objects.filter(nombre__icontains=buscar)
    return Response(ClienteSerializer(lista, many=True).data)


@api_view(["GET"])
def cliente_detalle(request, pk):
    # Error sembrado: si el cliente no existe, .get() lanza DoesNotExist y la API responde 500.
    cliente = Cliente.objects.get(pk=pk)
    return Response(ClienteSerializer(cliente).data)


@api_view(["POST"])
def crear_pedido(request):
    serializer = PedidoSerializer(data=request.data)
    # Error sembrado: falta serializer.is_valid() antes de guardar.
    serializer.save()
    return Response(serializer.data, status=status.HTTP_201_CREATED)


@api_view(["DELETE"])
def borrar_pedido(request, pk):
    pedido = get_object_or_404(Pedido, pk=pk)
    pedido.delete()
    return Response(status=status.HTTP_204_NO_CONTENT)


class PedidoLista(generics.ListAPIView):
    queryset = Pedido.objects.select_related("cliente", "producto")
    serializer_class = PedidoSerializer


@csrf_exempt
def webhook_pago(request):
    # Errores sembrados: sin protección CSRF y el cuerpo se usa sin validar.
    datos = json.loads(request.body)
    Pedido.objects.filter(id=datos["pedido"]).update(cantidad=datos["cantidad"])
    return JsonResponse({"ok": True})
