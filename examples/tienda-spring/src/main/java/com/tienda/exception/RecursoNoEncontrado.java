package com.tienda.exception;

public class RecursoNoEncontrado extends RuntimeException {
    public RecursoNoEncontrado(String que) {
        super(que + " no existe");
    }
}
