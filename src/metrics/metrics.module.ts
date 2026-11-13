import { Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { TransferMetrics } from './transfer-metrics';

@Module({
  providers: [MetricsService, TransferMetrics],
  exports: [MetricsService, TransferMetrics],
})
export class MetricsModule {}
