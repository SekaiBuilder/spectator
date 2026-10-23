import { IsString } from 'class-validator';

export class CuponDto {
  @IsString()
  codigo: string;
}
