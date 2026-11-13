import { randomUUID } from 'crypto';
import { createServer, IncomingHttpHeaders, Server } from 'http';
import { INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Counter } from 'prom-client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { MetricsService } from '../metrics/metrics.service';
import { TransferMetrics } from '../metrics/transfer-metrics';
import { TransferRequest } from './entities/transfer-request.entity';
import { TransferClientsService } from './transfer-clients.service';
import { TransfersController } from './transfers.controller';
import { TransfersService } from './transfers.service';

/**
 * Integración de una transferencia de punta a punta: la petición HTTP del cliente recorre el controlador, el
 * JWT, TransfersService (reglas de negocio) y TransferClientsService (el cliente HTTP real) hasta tres
 * servicios vecinos (auth, account y ledger). Los vecinos son servidores HTTP locales de verdad que registran
 * lo que reciben, así se prueba el contrato entre servicios: rutas, clave interna, token del cliente, cuerpo e
 * idempotencia. Solo se simula la base de datos (repositorio en memoria); nunca se toca un servicio real.
 */
const ANA = '11111111-1111-4111-8111-111111111111';
const CARLOS = '22222222-2222-4222-8222-222222222222';
const ORIGEN = '33333333-3333-4333-8333-333333333333';
const JWT_SECRET = 'secreto-de-prueba-para-el-jwt-de-clientes-0123456789';
const CLAVE_INTERNA = 'clave-interna-de-prueba-de-transfer-0123456789';

interface Llamada {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: any;
}
interface Respuesta {
  status?: number;
  body?: unknown;
}

/** Un servicio vecino de mentira: servidor HTTP real que guarda cada llamada y responde lo que se le indique. */
function servicioVecino() {
  const llamadas: Llamada[] = [];
  let responder: (llamada: Llamada) => Respuesta = () => ({});
  const server: Server = createServer((req, res) => {
    const partes: Buffer[] = [];
    req.on('data', (parte) => partes.push(parte));
    req.on('end', () => {
      const texto = Buffer.concat(partes).toString();
      const llamada: Llamada = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: texto ? JSON.parse(texto) : undefined,
      };
      llamadas.push(llamada);
      const { status = 200, body = {} } = responder(llamada);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  return {
    llamadas,
    responder: (fn: (llamada: Llamada) => Respuesta) => (responder = fn),
    escuchar: () =>
      new Promise<string>((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)),
      ),
    cerrar: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function matches(row: TransferRequest, where: Partial<TransferRequest>): boolean {
  return Object.entries(where).every(([key, value]) => row[key as keyof TransferRequest] === value);
}

/** Repositorio de TypeORM en memoria: lo que usa TransfersService, incluido el reclamo atómico de confirm(). */
function repositorioEnMemoria() {
  const rows = new Map<string, TransferRequest>();
  const copia = (row: TransferRequest) => ({ ...row });
  return {
    rows,
    findOne: async ({ where }: { where: Partial<TransferRequest> }) => {
      const row = [...rows.values()].find((r) => matches(r, where));
      return row ? copia(row) : null;
    },
    find: async ({ where }: { where: Partial<TransferRequest> }) =>
      [...rows.values()].filter((r) => matches(r, where)).map(copia),
    create: (data: Partial<TransferRequest>) => ({ ...data }) as TransferRequest,
    save: async (request: TransferRequest) => {
      const duplicada = [...rows.values()].find(
        (r) => r.idempotencyKey === request.idempotencyKey && r.id !== request.id,
      );
      if (duplicada) throw Object.assign(new Error('duplicate key'), { code: '23505' });
      request.id ??= randomUUID();
      request.createdAt ??= new Date();
      request.updatedAt = new Date();
      rows.set(request.id, copia(request));
      return request;
    },
    update: async (where: Partial<TransferRequest>, patch: Partial<TransferRequest>) => {
      let affected = 0;
      for (const row of rows.values()) {
        if (matches(row, where)) {
          Object.assign(row, patch, { updatedAt: new Date() });
          affected++;
        }
      }
      return { affected };
    },
    createQueryBuilder: () => {
      let params: { id?: string; userId?: string; stale?: Date } = {};
      const builder: any = {
        update: () => builder,
        set: () => builder,
        where: (_sql: string, p: typeof params) => ((params = { ...params, ...p }), builder),
        andWhere: (_sql: string, p: typeof params) => ((params = { ...params, ...p }), builder),
        execute: async () => {
          const row = rows.get(params.id as string);
          const reclamable =
            row &&
            row.userId === params.userId &&
            (row.status === 'pending' || (row.status === 'processing' && row.updatedAt < (params.stale as Date)));
          if (!row || !reclamable) return { affected: 0 };
          row.status = 'processing';
          row.updatedAt = new Date();
          return { affected: 1 };
        },
      };
      return builder;
    },
  };
}

const auth = servicioVecino();
const account = servicioVecino();
const ledger = servicioVecino();
const repositorio = repositorioEnMemoria();
const metricsService = new MetricsService(new ConfigService({}));
const jwt = new JwtService({});
const urls = { auth: '', account: '', ledger: '' };

@Module({
  controllers: [TransfersController],
  providers: [
    TransfersService,
    TransferClientsService,
    JwtAuthGuard,
    { provide: JwtService, useValue: jwt },
    {
      provide: ConfigService,
      useValue: {
        get: (key: string, fallback?: string) =>
          ({
            JWT_SECRET,
            INTERNAL_API_KEY: CLAVE_INTERNA,
            AUTH_SERVICE_URL: urls.auth,
            ACCOUNT_SERVICE_URL: urls.account,
            LEDGER_SERVICE_URL: urls.ledger,
          })[key] ?? fallback,
      },
    },
    { provide: TransferMetrics, useValue: new TransferMetrics(metricsService) },
    { provide: getRepositoryToken(TransferRequest), useValue: repositorio },
  ],
})
class TransferenciasDePruebaModule {}

describe('Transferencia de punta a punta (HTTP, reglas de negocio y servicios vecinos de verdad)', () => {
  let app: INestApplication;
  let base: string;

  const token = (idUser: string) => `Bearer ${jwt.sign({ sub: idUser, type: 'access' }, { secret: JWT_SECRET })}`;

  const http = async (metodo: string, ruta: string, opciones: { autorizacion?: string; cuerpo?: unknown } = {}) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opciones.autorizacion) headers.Authorization = opciones.autorizacion;
    const res = await fetch(`${base}${ruta}`, {
      method: metodo,
      headers,
      body: opciones.cuerpo === undefined ? undefined : JSON.stringify(opciones.cuerpo),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };

  const solicitud = (over: Record<string, unknown> = {}) => ({
    sourceAccountId: ORIGEN,
    destinationAccountNumber: '10000000002',
    amount: 50_000,
    description: 'Arriendo',
    idempotencyKey: randomUUID(),
    ...over,
  });

  const preparar = async (cuerpo = solicitud(), usuario = ANA) => {
    const res = await http('POST', '/transfers/prepare', { autorizacion: token(usuario), cuerpo });
    expect(res.status).toBe(201);
    return res.body as { id: string };
  };
  const confirmar = (id: string, usuario = ANA, dynamicCode = '123456') =>
    http('POST', `/transfers/${id}/confirm`, { autorizacion: token(usuario), cuerpo: { dynamicCode } });

  /** transfers_total con valor mayor que 0, como { 'resultado:motivo': cuenta }. */
  const contadas = async () => {
    const metric = metricsService.registry.getSingleMetric('transfers_total') as Counter;
    const { values } = await metric.get();
    return Object.fromEntries(
      values.filter((v) => v.value > 0).map((v) => [`${v.labels.result}:${v.labels.reason}`, v.value]),
    );
  };

  beforeAll(async () => {
    urls.auth = await auth.escuchar();
    urls.account = await account.escuchar();
    urls.ledger = await ledger.escuchar();
    app = await NestFactory.create(TransferenciasDePruebaModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await app.close();
    await Promise.all([auth.cerrar(), account.cerrar(), ledger.cerrar()]);
  });

  beforeEach(async () => {
    repositorio.rows.clear();
    for (const vecino of [auth, account, ledger]) vecino.llamadas.length = 0;
    metricsService.registry.resetMetrics();
    auth.responder(() => ({ body: { valid: true } }));
    account.responder((llamada) =>
      llamada.url.includes('/keys/resolve')
        ? { body: { accountNumber: '10000000002', key: 'carlos@correo.com', holderName: 'Ca* Gó*' } }
        : { body: { id: ORIGEN, idUser: ANA, accountType: 'savings', status: 'active' } },
    );
    ledger.responder((llamada) => ({
      body: { id: llamada.url.endsWith('/debits') ? 'tx-otro-banco' : 'tx-banklite' },
    }));
  });

  it('entre cuentas Banklite: se prepara, se confirma con la clave dinámica y el ledger recibe la transferencia con el token del cliente', async () => {
    const cuerpo = solicitud();
    const { id } = await preparar(cuerpo);

    const confirmada = await confirmar(id);

    expect(confirmada.status).toBe(201);
    expect(confirmada.body).toMatchObject({
      id,
      status: 'completed',
      ledgerTransactionId: 'tx-banklite',
      amount: 50_000,
    });
    // auth: valida la clave dinámica del titular con la clave interna
    expect(auth.llamadas).toHaveLength(1);
    expect(auth.llamadas[0]).toMatchObject({ method: 'POST', url: '/internal/dynamic-key/verify' });
    expect(auth.llamadas[0].body).toEqual({ idUser: ANA, code: '123456' });
    expect(auth.llamadas[0].headers['x-internal-key']).toBe(CLAVE_INTERNA);
    // ledger: transferencia con el token del cliente y la misma clave de idempotencia
    expect(ledger.llamadas).toHaveLength(1);
    expect(ledger.llamadas[0]).toMatchObject({ method: 'POST', url: '/ledger/transfers' });
    expect(ledger.llamadas[0].headers.authorization).toBe(token(ANA));
    expect(ledger.llamadas[0].headers['x-internal-key']).toBeUndefined();
    expect(ledger.llamadas[0].body).toEqual({
      sourceAccountId: ORIGEN,
      destinationAccountNumber: '10000000002',
      amount: 50_000,
      description: 'Arriendo',
      idempotencyKey: cuerpo.idempotencyKey,
    });

    // Aparece en el historial del cliente, y confirmar otra vez no mueve dinero dos veces
    const historial = await http('GET', '/transfers', { autorizacion: token(ANA) });
    expect(historial.body.map((t: { status: string }) => t.status)).toEqual(['completed']);
    const repetida = await confirmar(id);
    expect(repetida.body).toMatchObject({ id, status: 'completed', ledgerTransactionId: 'tx-banklite' });
    expect(ledger.llamadas).toHaveLength(1);
    expect(auth.llamadas).toHaveLength(1);
    expect(await contadas()).toEqual({ 'completed:none': 1 });
  });

  it('con una clave dinámica incorrecta no se mueve dinero: responde 400, el ledger no se toca y la solicitud sigue pendiente', async () => {
    auth.responder(() => ({ body: { valid: false, message: 'Clave dinámica incorrecta o vencida.' } }));
    const { id } = await preparar();

    const confirmada = await confirmar(id, ANA, '000000');

    expect(confirmada.status).toBe(400);
    expect(confirmada.body.message).toBe('Clave dinámica incorrecta o vencida.');
    expect(ledger.llamadas).toHaveLength(0);
    expect((await http('GET', '/transfers', { autorizacion: token(ANA) })).body[0].status).toBe('pending');
    expect(await contadas()).toEqual({ 'rejected:dynamic_key_invalid': 1 });
  });

  it('si el ledger rechaza por saldo insuficiente el cliente recibe el mismo 400, la solicitud queda pendiente y el reintento usa la misma clave de idempotencia', async () => {
    const cuerpo = solicitud();
    const { id } = await preparar(cuerpo);
    ledger.responder(() => ({ status: 400, body: { statusCode: 400, message: 'Saldo insuficiente' } }));

    const rechazada = await confirmar(id);

    expect(rechazada.status).toBe(400);
    expect(rechazada.body.message).toBe('Saldo insuficiente');
    expect((await http('GET', '/transfers', { autorizacion: token(ANA) })).body[0].status).toBe('pending');
    expect(await contadas()).toEqual({ 'rejected:insufficient_funds': 1 });

    // El cliente recarga y reintenta: se completa una sola vez
    ledger.responder(() => ({ body: { id: 'tx-banklite' } }));
    const reintento = await confirmar(id);

    expect(reintento.body).toMatchObject({ status: 'completed', ledgerTransactionId: 'tx-banklite' });
    expect(ledger.llamadas.map((l) => l.body.idempotencyKey)).toEqual([cuerpo.idempotencyKey, cuerpo.idempotencyKey]);
    expect(await contadas()).toEqual({ 'rejected:insufficient_funds': 1, 'completed:none': 1 });
  });

  it('si el ledger no está disponible responde 503 con un mensaje para reintentar, no pierde la solicitud y no cuenta un rechazo', async () => {
    const { id } = await preparar();
    ledger.responder(() => ({ status: 503, body: { message: 'caído' } }));

    const caida = await confirmar(id);

    expect(caida.status).toBe(503);
    expect(caida.body.message).toContain('Puedes reintentar la confirmación');
    expect((await http('GET', '/transfers', { autorizacion: token(ANA) })).body[0].status).toBe('pending');
    expect(await contadas()).toEqual({});
  });

  it('a otra entidad: valida en account que la cuenta de origen es del cliente y el ledger recibe un cargo con la clave interna, sin token del cliente', async () => {
    const cuerpo = {
      sourceAccountId: ORIGEN,
      destinationBank: 'Billetera Pulso',
      destinationAccountNumber: '3001234567',
      recipientName: 'Carlos Gómez',
      amount: 20_000,
      idempotencyKey: randomUUID(),
    };

    const preparada = await http('POST', '/transfers/prepare', { autorizacion: token(ANA), cuerpo });

    expect(preparada.status).toBe(201);
    expect(preparada.body).toMatchObject({
      status: 'pending',
      destinationBank: 'Billetera Pulso',
      destinationAccountNumber: null,
      destinationAccountLast4: '4567',
      recipientName: 'Carlos Gómez',
    });
    expect(account.llamadas[0].url).toBe(`/internal/accounts/${ORIGEN}/ledger-info`);
    expect(account.llamadas[0].headers['x-internal-key']).toBe(CLAVE_INTERNA);

    const confirmada = await confirmar(preparada.body.id);

    expect(confirmada.body).toMatchObject({ status: 'completed', ledgerTransactionId: 'tx-otro-banco' });
    expect(ledger.llamadas[0]).toMatchObject({ method: 'POST', url: '/ledger/internal/debits' });
    expect(ledger.llamadas[0].headers['x-internal-key']).toBe(CLAVE_INTERNA);
    expect(ledger.llamadas[0].headers.authorization).toBeUndefined();
    expect(ledger.llamadas[0].body).toMatchObject({
      accountId: ORIGEN,
      amount: 20_000,
      idempotencyKey: cuerpo.idempotencyKey,
    });
    expect(ledger.llamadas[0].body.description).toContain('Transferencia a Billetera Pulso');
  });

  it('no se envía desde una cuenta que no es del cliente: 403, no queda solicitud y se cuenta el rechazo', async () => {
    account.responder(() => ({ body: { id: ORIGEN, idUser: CARLOS, accountType: 'savings', status: 'active' } }));

    const res = await http('POST', '/transfers/prepare', {
      autorizacion: token(ANA),
      cuerpo: solicitud({
        destinationBank: 'Banco Cordillera',
        destinationAccountType: 'Ahorros',
        recipientName: 'Carlos Gómez',
      }),
    });

    expect(res.status).toBe(403);
    expect(repositorio.rows.size).toBe(0);
    expect(await contadas()).toEqual({ 'rejected:not_owner': 1 });
  });

  it('con una llave Banklite, account dice a qué cuenta llega; quien envía no ve el número pero el ledger sí lo recibe', async () => {
    const cuerpo = {
      sourceAccountId: ORIGEN,
      destinationKey: 'Carlos@Correo.com',
      amount: 15_000,
      idempotencyKey: randomUUID(),
    };

    const preparada = await http('POST', '/transfers/prepare', { autorizacion: token(ANA), cuerpo });

    expect(preparada.body).toMatchObject({
      destinationAccountNumber: null,
      destinationKey: 'carlos@correo.com',
      recipientName: 'Ca* Gó*',
    });
    expect(account.llamadas[0].url).toContain('/internal/accounts/keys/resolve?key=Carlos%40Correo.com');

    await confirmar(preparada.body.id);
    expect(ledger.llamadas[0].body.destinationAccountNumber).toBe('10000000002');
  });

  it('preparar dos veces con la misma clave de idempotencia devuelve la misma solicitud; con otro monto es un 409', async () => {
    const cuerpo = solicitud();
    const primera = await preparar(cuerpo);
    const segunda = await preparar(cuerpo);
    expect(segunda.id).toBe(primera.id);
    expect(repositorio.rows.size).toBe(1);

    const conflicto = await http('POST', '/transfers/prepare', {
      autorizacion: token(ANA),
      cuerpo: { ...cuerpo, amount: 99_000 },
    });
    expect(conflicto.status).toBe(409);
    expect(await contadas()).toEqual({ 'rejected:idempotency_conflict': 1 });
  });

  it('seguridad y ciclo de vida: sin token 401, la solicitud de otra persona no existe (404), una cancelada no se confirma y una completada no se cancela', async () => {
    const { id } = await preparar();

    expect((await http('GET', '/transfers')).status).toBe(401);
    expect((await confirmar(id, CARLOS)).status).toBe(404);
    expect(auth.llamadas).toHaveLength(0);

    const cancelada = await http('POST', `/transfers/${id}/cancel`, { autorizacion: token(ANA) });
    expect(cancelada.body.status).toBe('cancelled');
    expect((await confirmar(id)).status).toBe(409);
    expect(auth.llamadas).toHaveLength(0);
    expect(ledger.llamadas).toHaveLength(0);

    const otra = await preparar();
    await confirmar(otra.id);
    expect((await http('POST', `/transfers/${otra.id}/cancel`, { autorizacion: token(ANA) })).status).toBe(409);
  });

  it('datos inválidos se rechazan con 400 antes de tocar a ningún servicio: monto menor al mínimo y número de cuenta que no tiene 11 dígitos', async () => {
    const pequeno = await http('POST', '/transfers/prepare', {
      autorizacion: token(ANA),
      cuerpo: solicitud({ amount: 500 }),
    });
    expect(pequeno.status).toBe(400);

    const corto = await http('POST', '/transfers/prepare', {
      autorizacion: token(ANA),
      cuerpo: solicitud({ destinationAccountNumber: '123456' }),
    });
    expect(corto.status).toBe(400);
    expect(corto.body.message).toContain('11 dígitos');

    expect(repositorio.rows.size).toBe(0);
    for (const vecino of [auth, account, ledger]) expect(vecino.llamadas).toHaveLength(0);
  });
});
