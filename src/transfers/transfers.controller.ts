import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ConfirmTransferDto } from './dto/confirm-transfer.dto';
import { PrepareTransferDto } from './dto/prepare-transfer.dto';
import { TransfersService } from './transfers.service';

@Controller('transfers')
@UseGuards(JwtAuthGuard)
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  @Get()
  list(@Req() request: Request) {
    return this.transfers.list((request as any).user.idUser);
  }

  @Post('prepare')
  prepare(@Body() dto: PrepareTransferDto, @Req() request: Request) {
    return this.transfers.prepare(dto, (request as any).user.idUser);
  }

  @Post(':id/confirm')
  confirm(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ConfirmTransferDto, @Req() request: Request) {
    return this.transfers.confirm(id, (request as any).user.idUser, (request as any).accessToken, dto.dynamicCode);
  }

  @Post(':id/cancel')
  cancel(@Param('id', ParseUUIDPipe) id: string, @Req() request: Request) {
    return this.transfers.cancel(id, (request as any).user.idUser);
  }
}
