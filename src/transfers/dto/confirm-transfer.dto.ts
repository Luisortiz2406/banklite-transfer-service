import { Matches } from 'class-validator';

export class ConfirmTransferDto {
  // Clave dinámica de 6 dígitos (cambia cada 60 s). La valida Auth Service.
  @Matches(/^\d{6}$/, { message: 'Ingresa tu clave dinámica de 6 dígitos.' })
  dynamicCode: string;
}
