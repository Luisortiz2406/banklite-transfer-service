import { Controller, Get, INestApplication, Module, Param } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { Request } from 'express';
import { MetricsModule } from './metrics.module';
import { MetricsService, routeLabel } from './metrics.service';

/**
 * Métricas de Prometheus. Reglas: las etiquetas son de lista cerrada (plantilla de ruta, método y
 * código), nunca la URL con ids, correos o IPs; /metrics solo sale por su puerto aparte; y un fallo
 * de las métricas no tumba el servicio.
 */
const UUID = '123e4567-e89b-12d3-a456-426614174000';
const EMAIL = 'ana.perez@example.com';
// Datos que no pueden aparecer en ninguna métrica publicada.
const SENSIBLE = [
  /[\w.+-]+@[\w-]+\.[\w.]+/, // correo
  /\b\d{1,3}(\.\d{1,3}){3}\b/, // IPv4
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, // uuid (ids de usuario, cuenta, transacción)
  /\b\d{9,}\b/, // números largos (documentos, cuentas, tarjetas)
];

@Controller()
class EjemploController {
  @Get('ejemplo/:id')
  uno(@Param('id') id: string) {
    return { id };
  }
}

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), MetricsModule],
  controllers: [EjemploController],
})
class AplicacionDePrueba {}

const build = (env: Record<string, string> = { METRICS_PORT: '0' }) => new MetricsService(new ConfigService(env));
const get = (port: number, path: string, method = 'GET') =>
  fetch(`http://127.0.0.1:${port}${path}`, { method }).then(async (res) => ({
    status: res.status,
    type: res.headers.get('content-type'),
    text: await res.text(),
  }));

describe('routeLabel', () => {
  it('usa la plantilla de la ruta, no la URL', () => {
    expect(routeLabel({ route: { path: '/ledger/accounts/:id/balance' } } as Pick<Request, 'route'>)).toBe(
      '/ledger/accounts/:id/balance',
    );
  });

  it('sin ruta (404) es "unmatched" y una ruta con expresión regular es "regex"', () => {
    expect(routeLabel({} as Pick<Request, 'route'>)).toBe('unmatched');
    expect(routeLabel({ route: { path: /^\/x\/\d+$/ } } as unknown as Pick<Request, 'route'>)).toBe('regex');
  });

  it('recorta una plantilla demasiado larga', () => {
    expect(routeLabel({ route: { path: `/${'a'.repeat(500)}` } } as Pick<Request, 'route'>)).toHaveLength(120);
  });
});

describe('MetricsService', () => {
  const services: MetricsService[] = [];
  const started = async (env?: Record<string, string>) => {
    const service = build(env);
    services.push(service);
    await service.onModuleInit();
    return service;
  };
  afterEach(async () => {
    await Promise.all(services.splice(0).map((s) => s.onModuleDestroy()));
  });

  describe('registro de peticiones', () => {
    it('cuenta por plantilla de ruta, método y código, y mide la duración', async () => {
      const service = await started();
      service.record({ route: { path: '/ledger/balance/:id' }, method: 'get' } as never, 200, 0.03);
      service.record({ route: { path: '/ledger/balance/:id' }, method: 'GET' } as never, 200, 0.4);
      service.record({ route: { path: '/ledger/balance/:id' }, method: 'GET' } as never, 500, 1.2);

      const text = await service.registry.metrics();

      expect(text).toContain('http_requests_total{route="/ledger/balance/:id",method="GET",status="200"} 2');
      expect(text).toContain('http_requests_total{route="/ledger/balance/:id",method="GET",status="500"} 1');
      expect(text).toContain('http_request_duration_seconds_count{route="/ledger/balance/:id",method="GET"} 3');
      expect(text).toMatch(
        /http_request_duration_seconds_bucket\{le="0\.5",route="\/ledger\/balance\/:id",method="GET"\} 2/,
      );
    });

    it('un método raro se agrupa como OTHER (no crece el número de series)', async () => {
      const service = await started();
      service.record({ method: 'BREW' } as never, 404, 0.001);
      expect(await service.registry.metrics()).toContain('route="unmatched",method="OTHER",status="404"');
    });

    it('si registrar la petición falla, el evento no lanza (no tumba el proceso) y la petición sigue', async () => {
      const service = await started();
      jest.spyOn(service, 'record').mockImplementation(() => {
        throw new Error('prom-client roto');
      });
      const listeners: Record<string, () => void> = {};
      const res = { statusCode: 200, once: (event: string, cb: () => void) => (listeners[event] = cb) };
      const next = jest.fn();

      service.middleware()({ method: 'GET', route: { path: '/x' } } as never, res as never, next);

      expect(next).toHaveBeenCalled();
      expect(() => listeners.finish()).not.toThrow();
      expect(() => listeners.finish()).not.toThrow();
    });

    it('el middleware registra al terminar la respuesta, con el código real', async () => {
      const service = await started();
      const listeners: Record<string, () => void> = {};
      const res = { statusCode: 201, once: (event: string, cb: () => void) => (listeners[event] = cb) };
      const next = jest.fn();

      service.middleware()({ method: 'POST', route: { path: '/x' } } as never, res as never, next);
      expect(next).toHaveBeenCalled();
      expect(await service.registry.metrics()).not.toContain('route="/x"');
      listeners.finish();

      expect(await service.registry.metrics()).toContain(
        'http_requests_total{route="/x",method="POST",status="201"} 1',
      );
    });
  });

  describe('servidor /metrics (puerto aparte)', () => {
    it('responde las métricas en formato Prometheus: HTTP y las de Node (CPU, memoria, event loop)', async () => {
      const service = await started();
      const reply = await get(service.metricsPort()!, '/metrics');

      expect(reply.status).toBe(200);
      expect(reply.type).toContain('text/plain');
      expect(reply.text).toContain('# TYPE http_requests_total counter');
      expect(reply.text).toContain('# TYPE http_request_duration_seconds histogram');
      expect(reply.text).toContain('process_cpu_seconds_total');
      expect(reply.text).toContain('process_resident_memory_bytes');
      expect(reply.text).toContain('nodejs_eventloop_lag_p99_seconds');
      expect(reply.text).toContain('process_start_time_seconds');
    });

    it('solo sirve GET /metrics (con o sin parámetros); lo demás es 404', async () => {
      const service = await started();
      const port = service.metricsPort()!;

      expect((await get(port, '/metrics?x=1')).status).toBe(200);
      expect((await get(port, '/')).status).toBe(404);
      expect((await get(port, '/health')).status).toBe(404);
      expect((await get(port, '/metrics/extra')).status).toBe(404);
      expect((await get(port, '/metrics', 'POST')).status).toBe(404);
    });

    it('si generar las métricas falla, responde 500 y el servidor sigue', async () => {
      const service = await started();
      jest.spyOn(service.registry, 'metrics').mockRejectedValueOnce(new Error('falla'));

      expect((await get(service.metricsPort()!, '/metrics')).status).toBe(500);
      expect((await get(service.metricsPort()!, '/metrics')).status).toBe(200);
    });

    it('METRICS_PORT=off apaga el servidor; un valor inválido no lo inicia ni rompe el arranque', async () => {
      expect((await started({ METRICS_PORT: 'off' })).metricsPort()).toBeNull();
      for (const invalido of ['abc', '-1', '70000', '9100.5']) {
        expect((await started({ METRICS_PORT: invalido })).metricsPort()).toBeNull();
      }
    });

    it('si el puerto está ocupado el servicio arranca igual, sin métricas', async () => {
      const primero = await started();
      const ocupado = String(primero.metricsPort());

      const segundo = await started({ METRICS_PORT: ocupado });

      expect(segundo.metricsPort()).toBeNull();
      expect((await get(primero.metricsPort()!, '/metrics')).status).toBe(200);
    });

    it('al cerrar el módulo deja de escuchar', async () => {
      const service = await started();
      const port = service.metricsPort()!;

      await service.onModuleDestroy();

      expect(service.metricsPort()).toBeNull();
      await expect(get(port, '/metrics')).rejects.toThrow();
    });
  });

  describe('con una aplicación Nest real', () => {
    let app: INestApplication;
    let metrics: MetricsService;
    let base: string;

    beforeAll(async () => {
      process.env.METRICS_PORT = '0';
      app = await NestFactory.create(AplicacionDePrueba, { logger: false, abortOnError: false });
      metrics = app.get(MetricsService);
      app.use(metrics.middleware());
      await app.listen(0, '127.0.0.1');
      base = await app.getUrl();
    });
    afterAll(async () => {
      delete process.env.METRICS_PORT;
      await app.close();
    });

    it('la etiqueta es la plantilla de la ruta y nunca el id, el correo ni la IP de la petición', async () => {
      await fetch(`${base}/ejemplo/${UUID}?correo=${EMAIL}`);
      await fetch(`${base}/ejemplo/1234567890123`);
      await fetch(`${base}/no-existe/${EMAIL}/${UUID}`);
      await fetch(`${base}/ejemplo/x`, { method: 'DELETE', headers: { 'X-Forwarded-For': '203.0.113.7' } });
      await new Promise((resolve) => setTimeout(resolve, 50));

      const text = await metrics.registry.metrics();

      expect(text).toContain('http_requests_total{route="/ejemplo/:id",method="GET",status="200"} 2');
      expect(text).toContain('http_requests_total{route="unmatched",method="GET",status="404"} 1');
      expect(text).toContain('http_requests_total{route="unmatched",method="DELETE",status="404"} 1');
      // Se revisan las ETIQUETAS publicadas (lo que va entre llaves); los valores son números de medición.
      const etiquetas = [...text.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]).join(' | ');
      expect(etiquetas).toContain('route="/ejemplo/:id"');
      for (const patron of SENSIBLE) expect(etiquetas).not.toMatch(patron);
    });

    it('las únicas etiquetas propias son route, method y status', async () => {
      const text = await metrics.registry.metrics();
      const propias = text.split('\n').filter((l) => l.startsWith('http_'));
      const etiquetas = new Set(propias.flatMap((l) => [...l.matchAll(/([a-z_]+)="/g)].map((m) => m[1])));

      expect([...etiquetas].sort()).toEqual(['le', 'method', 'route', 'status']);
    });
  });
});
