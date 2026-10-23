package com.tienda.repository;

import com.tienda.model.Cliente;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface ClienteRepository extends JpaRepository<Cliente, Long> {

    List<Cliente> findByNombreCompleto(String nombreCompleto);

    boolean existsByEmail(String email);
}
