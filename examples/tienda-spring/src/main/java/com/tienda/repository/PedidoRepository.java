package com.tienda.repository;

import com.tienda.model.Pedido;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

import java.util.List;

public interface PedidoRepository extends JpaRepository<Pedido, Long> {

    @Query("SELECT p FROM Pedido p WHERE p.cliente.nombre = :nombre")
    List<Pedido> porCliente(String nombre);

    List<Pedido> findByTotalGreaterThan(java.math.BigDecimal minimo);
}
