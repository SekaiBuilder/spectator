import { IsInt, IsPositive, Min } from 'class-validator';

export class CrearPedidoDto {
  @IsInt()
  clienteId: number;

  @IsInt()
  productoId: number;

  @Min(1)
  cantidad: number;
}
