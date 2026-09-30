import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { TransferRequest } from './entities/transfer-request.entity';
import { TransfersController } from './transfers.controller';
import { TransfersService } from './transfers.service';

@Module({
  imports: [ConfigModule, JwtModule.register({}), TypeOrmModule.forFeature([TransferRequest])],
  controllers: [TransfersController],
  providers: [TransfersService, JwtAuthGuard],
})
export class TransfersModule {}