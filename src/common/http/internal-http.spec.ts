import { BadRequestException, HttpException, ServiceUnavailableException } from '@nestjs/common';
import { callService, expectOk, requestService, ServiceResponse } from './internal-http';

// Este archivo prueba la regla común de internal-http.ts (idéntico en todos los servicios).

const messageOf = (body: unknown) => (body as { message?: string | string[] } | undefined)?.message;

const res = (status: number, body: unknown = {}): ServiceResponse => ({
  status,
  ok: status >= 200 && status < 300,
  body,
  message: Array.isArray(messageOf(body))
    ? (messageOf(body) as string[]).join(', ')
    : ((messageOf(body) as string) ?? ''),
});

function statusOf(fn: () => unknown): { status: number; message: string } {
  try {
    fn();
  } catch (err) {
    const e = err as HttpException;
    const body = e.getResponse() as string | { message: string };
    return { status: e.getStatus(), message: typeof body === 'string' ? body : body.message };
  }
  throw new Error('no lanzó excepción');
}

describe('Regla común de errores entre servicios (expectOk)', () => {
  const internal = { service: 'Ledger Service', internal: true };
  const withUserToken = { service: 'Account Service', internal: false };

  it('2xx devuelve el cuerpo', () => {
    expect(expectOk(res(200, { id: 'tx-1' }), internal)).toEqual({ id: 'tx-1' });
  });

  it('4xx se reenvía con su estado y su mensaje', () => {
    expect(
      statusOf(() => expectOk(res(403, { message: 'La operación supera el límite diario de la cuenta.' }), internal)),
    ).toEqual({
      status: 403,
      message: 'La operación supera el límite diario de la cuenta.',
    });
    expect(statusOf(() => expectOk(res(409, { message: 'Ya existe.' }), internal)).status).toBe(409);
  });

  it('los mensajes de validación (lista) se unen', () => {
    expect(
      statusOf(() => expectOk(res(400, { message: ['amount debe ser positivo', 'falta la cuenta'] }), internal)),
    ).toEqual({
      status: 400,
      message: 'amount debe ser positivo, falta la cuenta',
    });
  });

  it('un 401 a una llamada con clave interna es configuración nuestra: 503 (no cierra la sesión del cliente)', () => {
    expect(statusOf(() => expectOk(res(401, { message: 'Clave interna inválida' }), internal)).status).toBe(503);
  });

  it('un 401 a una llamada con el token del cliente se reenvía', () => {
    expect(statusOf(() => expectOk(res(401, { message: 'Token inválido' }), withUserToken)).status).toBe(401);
  });

  it('5xx o sin respuesta: 503 con el mensaje para reintentar', () => {
    const options = { ...internal, unavailable: 'Puedes reintentar la confirmación.' };
    expect(statusOf(() => expectOk(res(500, { message: 'boom' }), options))).toEqual({
      status: 503,
      message: 'Puedes reintentar la confirmación.',
    });
    expect(statusOf(() => expectOk(null, options)).status).toBe(503);
  });

  it('una traducción explícita gana; si devuelve undefined, aplica la regla', () => {
    const options = {
      ...withUserToken,
      on: {
        404: () => new BadRequestException('Primero completa la verificación de identidad.'),
        409: () => undefined,
      },
    };
    expect(statusOf(() => expectOk(res(404), options))).toEqual({
      status: 400,
      message: 'Primero completa la verificación de identidad.',
    });
    expect(statusOf(() => expectOk(res(409, { message: 'Conflicto' }), options)).status).toBe(409);
  });
});

describe('requestService: tiempos y reintentos', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  const reply = (status: number, body: unknown = {}) =>
    Promise.resolve({ status, ok: status < 300, json: async () => body } as unknown as Response);

  it('una lectura con retry reintenta una vez ante 503 y devuelve la segunda respuesta', async () => {
    const fetchMock = jest
      .fn()
      .mockReturnValueOnce(reply(503))
      .mockReturnValueOnce(reply(200, { ok: 1 }));
    global.fetch = fetchMock as never;
    const response = await requestService('http://x/y', { retry: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response?.body).toEqual({ ok: 1 });
  });

  it('una escritura (sin retry) nunca se repite', async () => {
    const fetchMock = jest.fn().mockReturnValue(reply(503));
    global.fetch = fetchMock as never;
    const response = await requestService('http://x/y', { method: 'POST' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response?.status).toBe(503);
  });

  it('si la red falla devuelve null y callService responde 503', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as never;
    expect(await requestService('http://x/y')).toBeNull();
    await expect(callService('http://x/y', {}, { service: 'KYC Service', internal: true })).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('cada llamada lleva su tiempo máximo (AbortSignal)', async () => {
    const fetchMock = jest.fn().mockReturnValue(reply(200));
    global.fetch = fetchMock as never;
    await requestService('http://x/y', { timeoutMs: 1234 });
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});
