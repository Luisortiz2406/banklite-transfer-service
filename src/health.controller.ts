import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Response } from 'express';
import { DataSource } from 'typeorm';

// Si la base no contesta en este tiempo, se considera caída.
const DB_CHECK_TIMEOUT_MS = 1_500;

/**
 * GET /health: el servicio está arriba y su base responde (SELECT 1). Si la base
 * no responde, contesta 503 con status "down": el gateway y Railway lo ven caído.
 * Igual en todos los microservicios salvo el nombre del servicio.
 */
@Controller('health')
export class HealthController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Get()
  async check(@Res({ passthrough: true }) res: Response) {
    const start = Date.now();
    const dbOk = await this.pingDatabase();
    if (!dbOk) res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return {
      status: dbOk ? 'ok' : 'down',
      service: 'transfer-service',
      database: dbOk ? 'ok' : 'down',
      databaseLatencyMs: Date.now() - start,
      timestamp: new Date().toISOString(),
    };
  }

  private async pingDatabase(): Promise<boolean> {
    if (!this.dataSource.isInitialized) return false;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), DB_CHECK_TIMEOUT_MS);
    });
    try {
      await Promise.race([this.dataSource.query('SELECT 1'), timeout]);
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

// DEMO (no mergear): variable sin usar para que falle el lint del pipeline.
const variableSinUsar = 'falla a propósito';
