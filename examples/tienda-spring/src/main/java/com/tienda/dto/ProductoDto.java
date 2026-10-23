package com.tienda.dto;

import java.math.BigDecimal;

public record ProductoDto(Long id, String nombre, BigDecimal precio) {}
