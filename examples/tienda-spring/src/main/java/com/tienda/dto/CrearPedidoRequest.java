package com.tienda.dto;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;

public record CrearPedidoRequest(
        @NotNull Long clienteId,
        @NotNull Long productoId,
        @Min(1) int cantidad
) {}
