import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  // Sin CORS: el navegador solo habla con el api-gateway, que es quien decide los orígenes.
  const port = process.env.PORT ?? 3008;
  await app.listen(port);
  new Logger('Bootstrap').log(`Transfer Service escuchando en http://localhost:${port}`);
}

bootstrap();