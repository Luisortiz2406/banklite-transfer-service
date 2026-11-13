import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';

export const DEFAULT_METRICS_PORT = 9100;
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const KNOWN_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const MAX_ROUTE_LENGTH = 120;

/**
 * Etiqueta `route`: la PLANTILLA de la ruta (`/ledger/accounts/:id/balance`), nunca la URL con
 * ids, correos o IPs. Lo que no coincide con ninguna ruta (404, rutas ajenas) es `unmatched`:
 * así el número de series es fijo y ninguna etiqueta puede llevar datos del cliente.
 */
export function routeLabel(req: Pick<Request, 'route'>): string {
  const path: unknown = req.route?.path;
  if (typeof path === 'string') return path.slice(0, MAX_ROUTE_LENGTH);
  if (path !== undefined) return 'regex';
  return 'unmatched';
}

/**
 * Métricas de Prometheus de este servicio (prom-client):
 *   - http_requests_total{route,method,status} y http_request_duration_seconds{route,method};
 *   - las métricas por defecto de Node (CPU, memoria, event loop, GC).
 * Se publican en GET /metrics de un puerto APARTE (METRICS_PORT, 9100 por defecto) que solo se
 * alcanza por la red privada: el puerto público del servicio (PORT) no sirve /metrics. Prometheus
 * agrega la etiqueta `service` al consultar. Un fallo de las métricas nunca tumba el servicio.
 */
@Injectable()
export class MetricsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Metrics');
  readonly registry = new Registry();
  private readonly requests: Counter<'route' | 'method' | 'status'>;
  private readonly duration: Histogram<'route' | 'method'>;
  private server: Server | null = null;

  constructor(private readonly config: ConfigService) {
    collectDefaultMetrics({ register: this.registry });
    this.requests = new Counter({
      name: 'http_requests_total',
      help: 'Peticiones HTTP atendidas, por plantilla de ruta, método y código de estado.',
      labelNames: ['route', 'method', 'status'],
      registers: [this.registry],
    });
    this.duration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'Duración de las peticiones HTTP en segundos, por plantilla de ruta y método.',
      labelNames: ['route', 'method'],
      buckets: BUCKETS,
      registers: [this.registry],
    });
  }

  async onModuleInit() {
    await this.startServer();
  }

  async onModuleDestroy() {
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    this.registry.clear();
  }

  /** Middleware de Express: cuenta la petición y mide su duración cuando la respuesta termina. */
  middleware(): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
      const start = process.hrtime.bigint();
      res.once('finish', () => {
        const seconds = Number(process.hrtime.bigint() - start) / 1e9;
        this.record(req, res.statusCode, seconds);
      });
      next();
    };
  }

  record(req: Pick<Request, 'route' | 'method'>, status: number, seconds: number) {
    const route = routeLabel(req);
    const method = KNOWN_METHODS.has(req.method?.toUpperCase()) ? req.method.toUpperCase() : 'OTHER';
    this.requests.inc({ route, method, status: String(status) });
    this.duration.observe({ route, method }, seconds);
  }

  /** Puerto en el que escucha el servidor de métricas (null si está apagado o no pudo abrir). */
  metricsPort(): number | null {
    const address = this.server?.address();
    return address && typeof address === 'object' ? (address as AddressInfo).port : null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const path = (req.url ?? '').split('?')[0];
    if (req.method !== 'GET' || path !== '/metrics') {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not Found\n');
      return;
    }
    try {
      const body = await this.registry.metrics();
      res.writeHead(200, { 'Content-Type': this.registry.contentType }).end(body);
    } catch (error) {
      this.logger.warn(`No se pudieron generar las métricas: ${(error as Error).message}`);
      res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Error\n');
    }
  }

  private async startServer() {
    const raw = this.config.get<string>('METRICS_PORT')?.trim();
    if (raw?.toLowerCase() === 'off') {
      this.logger.log('METRICS_PORT=off: el servidor de métricas está apagado.');
      return;
    }
    const port = raw ? Number(raw) : DEFAULT_METRICS_PORT;
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      this.logger.warn('METRICS_PORT no es un puerto válido: el servidor de métricas no se inicia.');
      return;
    }
    // Primero dual-stack (IPv6 + IPv4: la red privada de Railway puede ser solo IPv6); sin IPv6, IPv4.
    for (const host of ['::', '0.0.0.0']) {
      const server = createServer((req, res) => void this.handle(req, res));
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, host, () => resolve());
        });
        server.on('error', (error) => this.logger.warn(`Error en el servidor de métricas: ${error.message}`));
        this.server = server;
        this.logger.log(`Métricas en el puerto ${this.metricsPort()} (solo red privada).`);
        return;
      } catch (error) {
        server.close();
        const code = (error as NodeJS.ErrnoException).code;
        if (host === '::' && (code === 'EAFNOSUPPORT' || code === 'EADDRNOTAVAIL')) continue;
        this.logger.warn(`No se pudo abrir el puerto de métricas ${port} (${code ?? (error as Error).message}).`);
        return;
      }
    }
  }
}
