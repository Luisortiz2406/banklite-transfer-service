import { BadRequestException, HttpException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TransferClientsService } from './transfer-clients.service';

/**
 * Llamadas de transfer-service a auth, account y ledger (fetch simulado). Lo que
 * importa: cada rechazo de negocio llega al cliente con su estado y mensaje, y
 * una falla del otro servicio nunca se confunde con un éxito.
 */

const KEY = 'clave-interna-de-transfer-para-pruebas-0123';
const reply = (status: number, body: unknown = {}) =>
  Promise.resolve({ status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response);

describe('TransferClientsService', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  const build = (env: Record<string, string> = {}) =>
    new TransferClientsService(new ConfigService({ INTERNAL_API_KEY: KEY, ...env }));
  const failure = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return error as HttpException;
    }
    throw new Error('no lanzó excepción');
  };

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as never;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  describe('verifyDynamicKey (auth-service)', () => {
    it('con una clave válida resuelve y manda el usuario, el código y la clave interna', async () => {
      fetchMock.mockReturnValue(reply(200, { valid: true }));

      await expect(build().verifyDynamicKey('user-1', '123456')).resolves.toBeUndefined();

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://localhost:3001/internal/dynamic-key/verify');
      expect(init.method).toBe('POST');
      expect(init.headers['x-internal-key']).toBe(KEY);
      expect(JSON.parse(init.body)).toEqual({ idUser: 'user-1', code: '123456' });
    });

    it('una clave incorrecta es un 400 con el mensaje de auth, o uno por defecto', async () => {
      fetchMock.mockReturnValueOnce(reply(200, { valid: false, message: 'La clave dinámica venció.' }));
      const withMessage = await failure(build().verifyDynamicKey('user-1', '000000'));
      expect(withMessage).toBeInstanceOf(BadRequestException);
      expect(withMessage.message).toBe('La clave dinámica venció.');

      fetchMock.mockReturnValueOnce(reply(200, {}));
      expect((await failure(build().verifyDynamicKey('user-1', '000000'))).message).toBe(
        'Clave dinámica incorrecta o vencida.',
      );
    });

    it('si auth no responde o rechaza nuestra clave interna: 503, no se confirma nada', async () => {
      fetchMock.mockReturnValueOnce(reply(401, { message: 'Clave interna inválida' }));
      const rejected = await failure(build().verifyDynamicKey('user-1', '123456'));
      expect(rejected).toBeInstanceOf(ServiceUnavailableException);
      expect(rejected.message).toBe('No se pudo validar la clave dinámica. Inténtalo de nuevo.');

      fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      expect(await failure(build().verifyDynamicKey('user-1', '123456'))).toBeInstanceOf(ServiceUnavailableException);
    });

    it('sin INTERNAL_API_KEY ni siquiera llama a auth', async () => {
      const service = new TransferClientsService(new ConfigService({}));
      const error = await failure(service.verifyDynamicKey('user-1', '123456'));

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(error.message).toContain('INTERNAL_API_KEY no está configurada');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('sourceAccount (account-service)', () => {
    it('devuelve titular, tipo y estado; arma la URL con la base sin barras finales', async () => {
      const info = { id: 'a/1', idUser: 'user-1', accountType: 'savings', status: 'active' };
      fetchMock.mockReturnValue(reply(200, info));

      const result = await build({ ACCOUNT_SERVICE_URL: 'http://account.interno:3002//' }).sourceAccount('a/1');

      expect(result).toEqual(info);
      expect(fetchMock.mock.calls[0][0]).toBe('http://account.interno:3002/internal/accounts/a%2F1/ledger-info');
      expect(fetchMock.mock.calls[0][1].headers['x-internal-key']).toBe(KEY);
    });

    it('una cuenta inexistente es 404 con el mensaje de transfer', async () => {
      fetchMock.mockReturnValue(reply(404, { message: 'Account not found' }));
      const error = await failure(build().sourceAccount('no-existe'));

      expect(error).toBeInstanceOf(NotFoundException);
      expect(error.message).toBe('Cuenta de origen no encontrada.');
    });

    it('lee con un reintento: un 503 seguido de un 200 funciona; dos 503 seguidos dan 503', async () => {
      fetchMock.mockReturnValueOnce(reply(503)).mockReturnValueOnce(reply(200, { id: 'a1' }));
      await expect(build().sourceAccount('a1')).resolves.toEqual({ id: 'a1' });
      expect(fetchMock).toHaveBeenCalledTimes(2);

      fetchMock.mockReset().mockReturnValue(reply(503));
      const error = await failure(build().sourceAccount('a1'));
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(error.message).toBe('No se pudo validar tu cuenta. Inténtalo de nuevo.');
    });
  });

  describe('resolveKey (account-service)', () => {
    it('devuelve la cuenta de la llave y la manda codificada en la URL', async () => {
      const resolved = { accountNumber: '10000000001', key: 'ana@correo.com', holderName: 'An* Pér*' };
      fetchMock.mockReturnValue(reply(200, resolved));

      expect(await build().resolveKey('ana+1@correo.com')).toEqual(resolved);
      expect(fetchMock.mock.calls[0][0]).toBe(
        'http://localhost:3002/internal/accounts/keys/resolve?key=ana%2B1%40correo.com',
      );
    });

    it('una llave que no existe o mal escrita conserva su estado (404 / 400) y su mensaje', async () => {
      fetchMock.mockReturnValueOnce(reply(404, { message: 'Esa llave no existe.' }));
      const notFound = await failure(build().resolveKey('x'));
      expect(notFound.getStatus()).toBe(404);
      expect(notFound.message).toBe('Esa llave no existe.');

      fetchMock.mockReturnValueOnce(reply(400, {}));
      const invalid = await failure(build().resolveKey('x'));
      expect(invalid.getStatus()).toBe(400);
      expect(invalid.message).toBe('No encontramos esa llave en Banklite.');
    });
  });

  describe('transfer (ledger, con el token del cliente)', () => {
    const body = {
      sourceAccountId: 'a1',
      destinationAccountNumber: '10000000002',
      amount: 1500,
      description: 'Arriendo',
      idempotencyKey: 'k1',
    };

    it('manda el token del cliente y la clave de idempotencia, y devuelve la transacción', async () => {
      fetchMock.mockReturnValue(reply(201, { id: 'tx-1' }));

      expect(await build().transfer(body, 'token-del-cliente')).toEqual({ id: 'tx-1' });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://localhost:3006/ledger/transfers');
      expect(init.headers.Authorization).toBe('Bearer token-del-cliente');
      expect(JSON.parse(init.body)).toEqual(body);
    });

    it('un rechazo de negocio del ledger (saldo, límite) llega con su estado y mensaje', async () => {
      fetchMock.mockReturnValueOnce(reply(400, { message: 'Saldo insuficiente.' }));
      const insufficient = await failure(build().transfer(body, 't'));
      expect(insufficient.getStatus()).toBe(400);
      expect(insufficient.message).toBe('Saldo insuficiente.');

      fetchMock.mockReturnValueOnce(reply(403, { message: 'La operación supera el límite diario de la cuenta.' }));
      expect((await failure(build().transfer(body, 't'))).getStatus()).toBe(403);
    });

    it('si el ledger falla (5xx o sin respuesta) es 503 y la escritura no se reintenta sola', async () => {
      fetchMock.mockReturnValue(reply(500, { message: 'boom' }));
      const error = await failure(build().transfer(body, 't'));

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(error.message).toContain('Puedes reintentar la confirmación');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('debitToClearing (ledger, red interna)', () => {
    const body = { accountId: 'a1', amount: 1500, description: 'Transferencia a otro banco', idempotencyKey: 'k1' };

    it('manda la clave interna y devuelve el cargo', async () => {
      fetchMock.mockReturnValue(reply(201, { id: 'tx-2' }));

      expect(await build({ LEDGER_SERVICE_URL: 'http://ledger.interno:3006/' }).debitToClearing(body)).toEqual({
        id: 'tx-2',
      });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://ledger.interno:3006/ledger/internal/debits');
      expect(init.headers['x-internal-key']).toBe(KEY);
    });

    it('saldo insuficiente se reenvía como 400; que el ledger rechace nuestra clave interna es 503', async () => {
      fetchMock.mockReturnValueOnce(reply(400, { message: 'Saldo insuficiente.' }));
      const insufficient = await failure(build().debitToClearing(body));
      expect(insufficient.getStatus()).toBe(400);
      expect(insufficient.message).toBe('Saldo insuficiente.');

      fetchMock.mockReturnValueOnce(reply(401, { message: 'Clave interna inválida' }));
      expect(await failure(build().debitToClearing(body))).toBeInstanceOf(ServiceUnavailableException);
    });
  });
});
