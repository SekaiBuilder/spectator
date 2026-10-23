import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CrearPedidoDto } from './dto/crear-pedido.dto';
import { Pedido } from './entities/pedido.entity';

@Injectable()
export class PedidosService {
  constructor(@InjectRepository(Pedido) private readonly pedidosRepository: Repository<Pedido>) {}

  listar() {
    return this.pedidosRepository.find();
  }

  async obtener(id: number): Promise<Pedido> {
    const pedido = await this.pedidosRepository.findOneBy({ id });
    if (!pedido) throw new NotFoundException('El pedido no existe');
    return pedido;
  }

  crear(dto: CrearPedidoDto) {
    return this.pedidosRepository.save({ clienteId: dto.clienteId, total: dto.cantidad * 10 });
  }
}
