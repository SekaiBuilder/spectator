package com.tienda.mapper;

import com.tienda.dto.PedidoResponse;
import com.tienda.model.Pedido;
import org.springframework.stereotype.Component;

@Component
public class PedidoMapper {

    public PedidoResponse toResponse(Pedido pedido) {
        return new PedidoResponse(pedido.getId(), pedido.getCliente().getNombre(), pedido.getTotal(), pedido.getCreadoEn());
    }
}
