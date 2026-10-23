import { Module } from '@nestjs/common';
import { PedidosController } from './pedidos/pedidos.controller';
import { PedidosService } from './pedidos/pedidos.service';

@Module({ controllers: [PedidosController], providers: [PedidosService] })
export class AppModule {}
