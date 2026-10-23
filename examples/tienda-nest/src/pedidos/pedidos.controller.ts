import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { CrearPedidoDto } from './dto/crear-pedido.dto';
import { Pedido } from './entities/pedido.entity';
import { PedidosService } from './pedidos.service';

@Controller('pedidos')
export class PedidosController {
  constructor(private readonly pedidosService: PedidosService) {}

  @Get()
  listar() {
    return this.pedidosService.listar();
  }

  @Get(':id')
  obtener(@Param('id') id: string): Promise<Pedido> {
    return this.pedidosService.obtener(Number(id));
  }

  @Post()
  crear(@Body() dto: CrearPedidoDto) {
    return this.pedidosService.crear(dto);
  }

  @Get(':id')
  detalle(@Param('id') id: string) {
    return this.pedidosService.obtener(Number(id));
  }
}
