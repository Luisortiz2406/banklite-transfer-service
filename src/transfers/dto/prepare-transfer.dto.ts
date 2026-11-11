import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { ACCEPTED_BANKS } from '../banks';

export const ACCOUNT_TYPES = ['Ahorros', 'Corriente'] as const;

// Mismo tope por operación que ledger-service (exacto en JavaScript y dentro de numeric(18,2)).
const MAX_AMOUNT = 999_999_999_999.99;
// Valor mínimo por envío (lo publica GET /transfers/catalog y lo dicen los términos).
export const TRANSFER_MIN = 1_000;

export class PrepareTransferDto {
  @IsUUID()
  sourceAccountId: string;

  // Número de cuenta (Banklite: 11 dígitos; otro banco: 6 a 16; billetera: celular)
  // o, en su lugar, una llave Banklite (destinationKey).
  @ValidateIf((dto) => !dto.destinationKey)
  @IsString()
  @Matches(/^\d{6,16}$/, { message: 'El número de cuenta destino debe tener solo dígitos.' })
  destinationAccountNumber?: string;

  // Envío a otro banco o billetera: entidad, tipo de cuenta y titular. Se aceptan
  // también los nombres antiguos (ver banks.ts) y el servicio los guarda con el nuevo.
  @IsOptional()
  @IsIn(ACCEPTED_BANKS as string[], { message: 'Esa entidad no está disponible.' })
  destinationBank?: string;

  @IsOptional()
  @IsIn(ACCOUNT_TYPES as unknown as string[], { message: 'El tipo de cuenta debe ser Ahorros o Corriente.' })
  destinationAccountType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  recipientName?: string;

  @ValidateIf((dto) => !dto.destinationAccountNumber)
  @IsString()
  @MaxLength(120)
  destinationKey?: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(TRANSFER_MIN, { message: 'El valor mínimo por envío es de $1.000.' })
  @Max(MAX_AMOUNT)
  amount: number;

  @IsUUID()
  idempotencyKey: string;

  @IsOptional()
  @IsString()
  @MaxLength(140)
  description?: string;
}
