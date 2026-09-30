import { IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';

export class PrepareTransferDto {
  @IsUUID()
  sourceAccountId: string;

  @IsString()
  @Matches(/^\d{11}$/, { message: 'destinationAccountNumber debe tener 11 dígitos' })
  destinationAccountNumber: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(9999999999999999)
  amount: number;

  @IsUUID()
  idempotencyKey: string;

  @IsOptional()
  @IsString()
  @MaxLength(140)
  description?: string;
}