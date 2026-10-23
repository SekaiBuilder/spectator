package com.tienda.dto;

import java.math.BigDecimal;
import java.time.LocalDateTime;

public record PedidoResponse(Long id, String cliente, BigDecimal total, LocalDateTime creadoEn) {}
