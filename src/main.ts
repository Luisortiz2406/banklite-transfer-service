import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { MetricsService } from './metrics/metrics.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Cuenta y mide cada petición (las métricas se publican en el puerto METRICS_PORT, solo red privada).
  app.use(app.get(MetricsService).middleware());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  // Sin CORS: el navegador solo habla con el api-gateway, que es quien decide los orígenes.
  const port = process.env.PORT ?? 3008;
  await app.listen(port);
  new Logger('Bootstrap').log(`Transfer Service escuchando en http://localhost:${port}`);
}

bootstrap();
