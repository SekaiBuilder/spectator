package com.tienda.controller;

import com.tienda.dto.ClienteRequest;
import com.tienda.model.Cliente;
import com.tienda.repository.ClienteRepository;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/clientes")
public class ClienteController {

    @Autowired
    private ClienteRepository clienteRepository;

    @GetMapping("/{id}")
    public Cliente obtener(@PathVariable Long id) {
        return clienteRepository.findById(id).get();
    }

    @GetMapping("/{id}")
    public Cliente buscar(@PathVariable Long id) {
        return clienteRepository.findById(id).orElse(null);
    }

    @PostMapping
    public Cliente crear(@RequestBody ClienteRequest request) {
        Cliente cliente = new Cliente();
        cliente.setNombre(request.getNombre());
        cliente.setEmail(request.getEmail());
        return clienteRepository.save(cliente);
    }

    @GetMapping("/buscar")
    public java.util.List<Cliente> porNombre(@RequestParam String nombre) {
        return clienteRepository.findByNombreCompleto(nombre);
    }
}
