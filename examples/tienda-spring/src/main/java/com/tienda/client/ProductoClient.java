package com.tienda.client;

import com.tienda.dto.ProductoDto;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

import java.math.BigDecimal;

@Component
public class ProductoClient {

    private final RestTemplate restTemplate = new RestTemplate();

    public BigDecimal precio(Long productoId) {
        ProductoDto producto = restTemplate.getForObject("https://api.proveedor.com/productos/{id}", ProductoDto.class, productoId);
        return producto.precio();
    }
}
