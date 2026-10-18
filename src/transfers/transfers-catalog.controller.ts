import { Controller, Get } from '@nestjs/common';
import { TRANSFER_MIN } from './dto/prepare-transfer.dto';

/** Topes de transferencias, públicos (sin sesión): los usan los términos y Banki. */
@Controller('transfers')
export class TransfersCatalogController {
  @Get('catalog')
  catalog() {
    return { min: TRANSFER_MIN };
  }
}
