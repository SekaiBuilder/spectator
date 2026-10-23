package com.tienda.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;

public class ClienteRequest {

    @NotBlank
    private String nombre;

    @Email
    private String email;

    public String getNombre() { return nombre; }
    public String getEmail() { return email; }
}
