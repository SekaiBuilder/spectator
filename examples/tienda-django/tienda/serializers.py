from rest_framework import serializers

from .models import Cliente, Pedido, Producto


class ClienteSerializer(serializers.ModelSerializer):
    # Error sembrado: '__all__' también envía la contraseña al cliente.
    class Meta:
        model = Cliente
        fields = "__all__"


class ProductoSerializer(serializers.ModelSerializer):
    class Meta:
        model = Producto
        fields = ["id", "nombre", "precio", "descripcion"]
        read_only_fields = ["id"]


class PedidoSerializer(serializers.ModelSerializer):
    cantidad = serializers.IntegerField(min_value=1, max_value=50)

    class Meta:
        model = Pedido
        fields = ["id", "cliente", "producto", "cantidad"]
        read_only_fields = ["id"]


# Error sembrado: nadie lo usa.
class ResumenVentasSerializer(serializers.Serializer):
    total = serializers.DecimalField(max_digits=10, decimal_places=2)
