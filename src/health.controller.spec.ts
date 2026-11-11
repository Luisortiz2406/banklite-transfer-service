import { HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { DataSource } from 'typeorm';
import { HealthController } from './health.controller';

// GET /health: arriba y con la base respondiendo; si la base no contesta, 503 "down".

const response = () => ({ status: jest.fn() }) as unknown as Response & { status: jest.Mock };
const controller = (dataSource: Partial<DataSource>) => new HealthController(dataSource as DataSource);

describe('GET /health', () => {
  afterEach(() => jest.useRealTimers());

  it('con la base respondiendo devuelve ok y no cambia el estado HTTP', async () => {
    const query = jest.fn().mockResolvedValue([{ '?column?': 1 }]);
    const res = response();

    const body = await controller({ isInitialized: true, query }).check(res);

    expect(query).toHaveBeenCalledWith('SELECT 1');
    expect(body).toMatchObject({ status: 'ok', service: 'transfer-service', database: 'ok' });
    expect(typeof body.databaseLatencyMs).toBe('number');
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('si la base todavía no se inicializó responde 503 sin consultarla', async () => {
    const query = jest.fn();
    const res = response();

    const body = await controller({ isInitialized: false, query }).check(res);

    expect(query).not.toHaveBeenCalled();
    expect(body).toMatchObject({ status: 'down', database: 'down' });
    expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
  });

  it('si la consulta falla responde 503', async () => {
    const res = response();

    const body = await controller({
      isInitialized: true,
      query: jest.fn().mockRejectedValue(new Error('conexión rechazada')),
    }).check(res);

    expect(body).toMatchObject({ status: 'down', database: 'down' });
    expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
  });

  it('si la base no contesta en 1,5 s se considera caída', async () => {
    jest.useFakeTimers();
    const res = response();

    const pending = controller({ isInitialized: true, query: jest.fn(() => new Promise(() => undefined)) }).check(res);
    await jest.advanceTimersByTimeAsync(1_500);

    expect(await pending).toMatchObject({ status: 'down' });
    expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
  });
});
