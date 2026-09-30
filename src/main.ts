import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  app.enableCors();
  const port = process.env.PORT ?? 3008;
  await app.listen(port);
  console.log(`Transfer Service escuchando en http://localhost:${port}`);
}

bootstrap();