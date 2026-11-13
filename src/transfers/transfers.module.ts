import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { MetricsModule } from '../metrics/metrics.module';
import { TransferRequest } from './entities/transfer-request.entity';
import { TransfersCatalogController } from './transfers-catalog.controller';
import { TransfersController } from './transfers.controller';
import { TransferClientsService } from './transfer-clients.service';
import { TransfersService } from './transfers.service';

@Module({
  imports: [ConfigModule, JwtModule.register({}), TypeOrmModule.forFeature([TransferRequest]), MetricsModule],
  controllers: [TransfersCatalogController, TransfersController],
  providers: [TransfersService, TransferClientsService, JwtAuthGuard],
})
export class TransfersModule {}
