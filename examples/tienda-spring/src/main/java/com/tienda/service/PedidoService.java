package com.tienda.service;

import com.tienda.client.ProductoClient;
import com.tienda.dto.CrearPedidoRequest;
import com.tienda.dto.PedidoResponse;
import com.tienda.exception.RecursoNoEncontrado;
import com.tienda.mapper.PedidoMapper;
import com.tienda.model.Cliente;
import com.tienda.model.Pedido;
import com.tienda.repository.ClienteRepository;
import com.tienda.repository.PedidoRepository;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.List;

@Service
public class PedidoService {

    private final PedidoRepository pedidoRepository;
    private final ClienteRepository clienteRepository;
    private final ProductoClient productoClient;
    private final PedidoMapper pedidoMapper;

    public PedidoService(PedidoRepository pedidoRepository, ClienteRepository clienteRepository, ProductoClient productoClient, PedidoMapper pedidoMapper) {
        this.pedidoRepository = pedidoRepository;
        this.clienteRepository = clienteRepository;
        this.productoClient = productoClient;
        this.pedidoMapper = pedidoMapper;
    }

    public List<PedidoResponse> listar() {
        return pedidoRepository.findAll().stream().map(pedidoMapper::toResponse).toList();
    }

    public PedidoResponse obtener(Long id) {
        Pedido pedido = pedidoRepository.findById(id)
                .orElseThrow(() -> new RecursoNoEncontrado("Pedido " + id));
        return pedidoMapper.toResponse(pedido);
    }

    public PedidoResponse crear(CrearPedidoRequest request) {
        Cliente cliente = clienteRepository.findById(request.clienteId())
                .orElseThrow(() -> new RecursoNoEncontrado("Cliente " + request.clienteId()));
        BigDecimal precio = productoClient.precio(request.productoId());
        Pedido pedido = new Pedido();
        pedido.setCliente(cliente);
        pedido.setProductoId(request.productoId());
        pedido.setTotal(precio.multiply(BigDecimal.valueOf(request.cantidad())));
        pedido.setCreadoEn(LocalDateTime.now());
        Pedido guardado = pedidoRepository.save(pedido);
        return pedidoMapper.toResponse(guardado);
    }

    public void borrar(Long id) {
        pedidoRepository.deleteById(id);
    }
}
