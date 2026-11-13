import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { Counter } from 'prom-client';
import { MetricsService } from '../metrics/metrics.service';
import { TRANSFER_REJECTIONS, TransferMetrics } from '../metrics/transfer-metrics';
import { PrepareTransferDto } from './dto/prepare-transfer.dto';
import { TransferRequest } from './entities/transfer-request.entity';
import { TransferClientsService } from './transfer-clients.service';
import { TransfersService } from './transfers.service';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const SOURCE = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'token-de-acceso';

function matches(row: TransferRequest, where: Partial<TransferRequest>): boolean {
  return Object.entries(where).every(([key, value]) => row[key as keyof TransferRequest] === value);
}

/**
 * Repositorio de TypeORM en memoria: lo justo para TransfersService (findOne, create,
 * save, update y el reclamo atómico con createQueryBuilder). Devuelve copias, como la base.
 */
function fakeRepository() {
  const rows = new Map<string, TransferRequest>();
  const copy = (row: TransferRequest) => ({ ...row });
  const repo = {
    rows,
    findOne: jest.fn(async ({ where }: { where: Partial<TransferRequest> }) => {
      const row = [...rows.values()].find((r) => matches(r, where));
      return row ? copy(row) : null;
    }),
    find: jest.fn(async ({ where }: { where: Partial<TransferRequest> }) =>
      [...rows.values()].filter((r) => matches(r, where)).map(copy),
    ),
    create: jest.fn((data: Partial<TransferRequest>) => ({ ...data }) as TransferRequest),
    save: jest.fn(async (request: TransferRequest) => {
      const duplicate = [...rows.values()].find(
        (r) => r.idempotencyKey === request.idempotencyKey && r.id !== request.id,
      );
      if (duplicate) throw Object.assign(new Error('duplicate key'), { code: '23505' });
      request.id ??= randomUUID();
      request.createdAt ??= new Date();
      request.updatedAt = new Date();
      rows.set(request.id, copy(request));
      return request;
    }),
    update: jest.fn(async (where: Partial<TransferRequest>, patch: Partial<TransferRequest>) => {
      let affected = 0;
      for (const row of rows.values()) {
        if (matches(row, where)) {
          Object.assign(row, patch, { updatedAt: new Date() });
          affected++;
        }
      }
      return { affected };
    }),
    // Reclamo de confirm(): pendiente, o 'processing' más vieja que el límite.
    createQueryBuilder: jest.fn(() => {
      let params: { id?: string; userId?: string; stale?: Date } = {};
      const builder = {
        update: () => builder,
        set: () => builder,
        where: (_sql: string, p: typeof params) => ((params = { ...params, ...p }), builder),
        andWhere: (_sql: string, p: typeof params) => ((params = { ...params, ...p }), builder),
        execute: async () => {
          const row = rows.get(params.id);
          const claimable =
            row &&
            row.userId === params.userId &&
            (row.status === 'pending' || (row.status === 'processing' && row.updatedAt < params.stale));
          if (!claimable) return { affected: 0 };
          row.status = 'processing';
          row.updatedAt = new Date();
          return { affected: 1 };
        },
      };
      return builder;
    }),
  };
  return repo;
}

function setup() {
  const repo = fakeRepository();
  const clients = {
    verifyDynamicKey: jest.fn().mockResolvedValue(undefined),
    resolveKey: jest
      .fn()
      .mockResolvedValue({ accountNumber: '10000000001', key: 'ana@correo.com', holderName: 'An* Pér*' }),
    sourceAccount: jest.fn().mockResolvedValue({ id: SOURCE, idUser: USER, accountType: 'savings', status: 'active' }),
    transfer: jest.fn().mockResolvedValue({ id: 'tx-banklite' }),
    debitToClearing: jest.fn().mockResolvedValue({ id: 'tx-otro-banco' }),
  };
  // Métricas reales (sin abrir el puerto): así las pruebas leen lo que se publicaría en /metrics.
  const metricsService = new MetricsService(new ConfigService({}));
  const service = new TransfersService(
    repo as never,
    clients as unknown as TransferClientsService,
    new TransferMetrics(metricsService),
  );
  return { service, repo, clients, metricsService };
}

/** transfers_total con valor mayor que 0, como { 'resultado:motivo': cuenta }. */
async function counted(metricsService: MetricsService) {
  const metric = metricsService.registry.getSingleMetric('transfers_total') as Counter;
  const { values } = await metric.get();
  return Object.fromEntries(
    values.filter((v) => v.value > 0).map((v) => [`${v.labels.result}:${v.labels.reason}`, v.value]),
  );
}

function dto(overrides: Partial<PrepareTransferDto> = {}): PrepareTransferDto {
  return {
    sourceAccountId: SOURCE,
    destinationAccountNumber: '10000000002',
    amount: 1500,
    idempotencyKey: randomUUID(),
    ...overrides,
  } as PrepareTransferDto;
}

function toBank(overrides: Partial<PrepareTransferDto> = {}): PrepareTransferDto {
  return dto({
    destinationBank: 'Banco Cordillera',
    destinationAccountType: 'Ahorros',
    destinationAccountNumber: '12345678',
    recipientName: 'Carlos Gómez',
    ...overrides,
  });
}

describe('Preparar una transferencia', () => {
  it('entre cuentas Banklite: crea la solicitud pendiente con el monto y la descripción por defecto', async () => {
    const { service, repo } = setup();
    const result = await service.prepare(dto(), USER);

    expect(result).toMatchObject({
      status: 'pending',
      amount: 1500,
      description: 'Transferencia',
      destinationAccountNumber: '10000000002',
      destinationAccountLast4: '0002',
      ledgerTransactionId: null,
    });
    expect([...repo.rows.values()][0].amount).toBe('1500.00');
  });

  it('entre cuentas Banklite: rechaza un número que no tiene 11 dígitos', async () => {
    const { service, repo } = setup();
    await expect(service.prepare(dto({ destinationAccountNumber: '123456' }), USER)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repo.rows.size).toBe(0);
  });

  it('con llave Banklite: usa la cuenta que resuelve account-service y no muestra su número', async () => {
    const { service, clients, repo } = setup();
    const result = await service.prepare(
      dto({ destinationAccountNumber: undefined, destinationKey: 'Ana@Correo.com' }),
      USER,
    );

    expect(clients.resolveKey).toHaveBeenCalledWith('Ana@Correo.com');
    expect(result.destinationAccountNumber).toBeNull();
    expect(result).toMatchObject({ destinationKey: 'ana@correo.com', recipientName: 'An* Pér*' });
    expect([...repo.rows.values()][0].destinationAccountNumber).toBe('10000000001');
  });

  describe('a otro banco o billetera', () => {
    it('acepta un envío válido y valida que la cuenta de origen sea del cliente', async () => {
      const { service, clients } = setup();
      const result = await service.prepare(toBank(), USER);

      expect(clients.sourceAccount).toHaveBeenCalledWith(SOURCE);
      expect(result).toMatchObject({
        destinationBank: 'Banco Cordillera',
        destinationAccountType: 'Ahorros',
        destinationAccountNumber: null,
        destinationAccountLast4: '5678',
        recipientName: 'Carlos Gómez',
      });
    });

    it('en una billetera exige un celular de 10 dígitos que empiece por 3', async () => {
      const { service } = setup();
      const billetera = { destinationBank: 'Billetera Pulso', destinationAccountType: undefined };
      await expect(
        service.prepare(toBank({ ...billetera, destinationAccountNumber: '2001234567' }), USER),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.prepare(toBank({ ...billetera, destinationAccountNumber: '3001234567' }), USER),
      ).resolves.toMatchObject({ destinationBank: 'Billetera Pulso', destinationAccountType: null });
    });

    it('en un banco exige el tipo de cuenta', async () => {
      const { service } = setup();
      await expect(service.prepare(toBank({ destinationAccountType: undefined }), USER)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('exige el nombre de quien recibe', async () => {
      const { service } = setup();
      await expect(service.prepare(toBank({ recipientName: ' Al ' }), USER)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rechaza una cuenta de origen de otro cliente o de un comercio', async () => {
      const { service, clients } = setup();
      clients.sourceAccount.mockResolvedValueOnce({ idUser: OTHER_USER, accountType: 'savings', status: 'active' });
      await expect(service.prepare(toBank(), USER)).rejects.toBeInstanceOf(ForbiddenException);

      clients.sourceAccount.mockResolvedValueOnce({ idUser: USER, accountType: 'merchant', status: 'active' });
      await expect(service.prepare(toBank(), USER)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rechaza una cuenta de origen que no está activa', async () => {
      const { service, clients } = setup();
      clients.sourceAccount.mockResolvedValueOnce({ idUser: USER, accountType: 'savings', status: 'blocked' });
      await expect(service.prepare(toBank(), USER)).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});

describe('Idempotencia al preparar', () => {
  it('reenviar la misma clave con los mismos datos devuelve la misma solicitud sin crear otra', async () => {
    const { service, repo } = setup();
    const request = dto();
    const first = await service.prepare(request, USER);
    const second = await service.prepare({ ...request }, USER);

    expect(second.id).toBe(first.id);
    expect(repo.rows.size).toBe(1);
  });

  it('reusar la clave con otro monto, otro destino u otro usuario da 409', async () => {
    const { service } = setup();
    const request = dto();
    await service.prepare(request, USER);

    await expect(service.prepare({ ...request, amount: 2000 }, USER)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.prepare({ ...request, destinationAccountNumber: '10000000009' }, USER)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(service.prepare({ ...request }, OTHER_USER)).rejects.toBeInstanceOf(ConflictException);
  });

  it('si otra petición con la misma clave gana la carrera al guardar, devuelve esa solicitud', async () => {
    const { service, repo } = setup();
    const request = dto();
    const winner = await service.prepare(request, USER);
    // La primera búsqueda no la ve (todavía no estaba guardada); al guardar choca con la clave única.
    repo.findOne.mockResolvedValueOnce(null);

    const result = await service.prepare({ ...request }, USER);
    expect(result.id).toBe(winner.id);
    expect(repo.rows.size).toBe(1);
  });
});

describe('Confirmar una transferencia', () => {
  async function prepared(request = dto()) {
    const ctx = setup();
    const { id } = await ctx.service.prepare(request, USER);
    return { ...ctx, id };
  }

  it('con clave dinámica válida mueve el dinero en el ledger y queda completada', async () => {
    const { service, clients, id } = await prepared();
    const result = await service.confirm(id, USER, TOKEN, '123456');

    expect(clients.verifyDynamicKey).toHaveBeenCalledWith(USER, '123456');
    expect(clients.transfer).toHaveBeenCalledWith(
      expect.objectContaining({ sourceAccountId: SOURCE, destinationAccountNumber: '10000000002', amount: 1500 }),
      TOKEN,
    );
    expect(result).toMatchObject({ status: 'completed', ledgerTransactionId: 'tx-banklite' });
  });

  it('con clave dinámica incorrecta no reclama la solicitud ni llama al ledger', async () => {
    const { service, clients, repo, id } = await prepared();
    clients.verifyDynamicKey.mockRejectedValueOnce(new BadRequestException('Clave dinámica incorrecta o vencida.'));

    await expect(service.confirm(id, USER, TOKEN, '000000')).rejects.toBeInstanceOf(BadRequestException);
    expect(clients.transfer).not.toHaveBeenCalled();
    expect(repo.rows.get(id).status).toBe('pending');
  });

  it('si el ledger falla, la solicitud vuelve a pendiente para poder reintentar con la misma clave', async () => {
    const { service, clients, repo, id } = await prepared();
    clients.transfer.mockRejectedValueOnce(new Error('ledger no responde'));

    await expect(service.confirm(id, USER, TOKEN, '123456')).rejects.toThrow('ledger no responde');
    expect(repo.rows.get(id).status).toBe('pending');

    const retry = await service.confirm(id, USER, TOKEN, '123456');
    expect(retry.status).toBe('completed');
    const keys = clients.transfer.mock.calls.map(([body]) => body.idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
  });

  it('confirmar una solicitud ya completada la devuelve sin volver a mover dinero', async () => {
    const { service, clients, id } = await prepared();
    await service.confirm(id, USER, TOKEN, '123456');
    const again = await service.confirm(id, USER, TOKEN, '123456');

    expect(again.status).toBe('completed');
    expect(clients.transfer).toHaveBeenCalledTimes(1);
  });

  it('una solicitud que ya se está procesando da 409 y no llama al ledger', async () => {
    const { service, clients, repo, id } = await prepared();
    repo.rows.get(id).status = 'processing';

    await expect(service.confirm(id, USER, TOKEN, '123456')).rejects.toBeInstanceOf(ConflictException);
    expect(clients.transfer).not.toHaveBeenCalled();
  });

  it('una solicitud cancelada no se puede confirmar', async () => {
    const { service, clients, id } = await prepared();
    await service.cancel(id, USER);

    await expect(service.confirm(id, USER, TOKEN, '123456')).rejects.toBeInstanceOf(ConflictException);
    expect(clients.verifyDynamicKey).not.toHaveBeenCalled();
  });

  it('otro cliente no puede confirmar la solicitud', async () => {
    const { service, clients, id } = await prepared();
    await expect(service.confirm(id, OTHER_USER, TOKEN, '123456')).rejects.toBeInstanceOf(NotFoundException);
    expect(clients.transfer).not.toHaveBeenCalled();
  });

  it('a otro banco: carga hacia la cuenta de compensación con solo los últimos 4 dígitos en la descripción', async () => {
    const { service, clients, id } = await prepared(toBank({ description: 'Arriendo' }));
    const result = await service.confirm(id, USER, TOKEN, '123456');

    expect(clients.transfer).not.toHaveBeenCalled();
    expect(clients.debitToClearing).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: SOURCE,
        amount: 1500,
        description: 'Transferencia a Banco Cordillera · Ahorros ···· 5678 · Carlos Gómez · Arriendo',
      }),
    );
    expect(clients.debitToClearing.mock.calls[0][0].description).not.toContain('12345678');
    expect(result).toMatchObject({ status: 'completed', ledgerTransactionId: 'tx-otro-banco' });
  });
});

describe('Cancelar una transferencia', () => {
  it('cancela una pendiente y cancelar otra vez devuelve lo mismo', async () => {
    const { service } = setup();
    const { id } = await service.prepare(dto(), USER);

    await expect(service.cancel(id, USER)).resolves.toMatchObject({ status: 'cancelled' });
    await expect(service.cancel(id, USER)).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('no cancela una transferencia completada', async () => {
    const { service } = setup();
    const { id } = await service.prepare(dto(), USER);
    await service.confirm(id, USER, TOKEN, '123456');

    await expect(service.cancel(id, USER)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('Nombres anteriores de las entidades', () => {
  // Un frontend viejo o una solicitud guardada antes del cambio de nombres usa el nombre antiguo.
  it('si llega un nombre antiguo, guarda y muestra el vigente (banco y billetera)', async () => {
    const { service, repo } = setup();
    const banco = await service.prepare(toBank({ destinationBank: 'Banco Demo Cóndor' }), USER);
    const billetera = await service.prepare(
      toBank({
        destinationBank: 'Billetera Demo Colibrí',
        destinationAccountType: undefined,
        destinationAccountNumber: '3001234567',
      }),
      USER,
    );

    expect(banco.destinationBank).toBe('Banco Cordillera');
    expect(billetera.destinationBank).toBe('Billetera Pulso');
    expect([...repo.rows.values()].map((row) => row.destinationBank)).toEqual(['Banco Cordillera', 'Billetera Pulso']);
  });

  it('una solicitud guardada con el nombre antiguo se muestra y se cobra con el vigente', async () => {
    const { service, repo, clients } = setup();
    const { id } = await service.prepare(toBank({ description: 'Arriendo' }), USER);
    repo.rows.get(id).destinationBank = 'Banco Demo Cóndor';

    const [listed] = await service.list(USER);
    expect(listed.destinationBank).toBe('Banco Cordillera');

    await service.confirm(id, USER, TOKEN, '123456');
    expect(clients.debitToClearing.mock.calls[0][0].description).toBe(
      'Transferencia a Banco Cordillera · Ahorros ···· 5678 · Carlos Gómez · Arriendo',
    );
  });

  it('reintentar con la misma clave y el nombre vigente no da 409 si se guardó con el antiguo', async () => {
    const { service, repo } = setup();
    const request = toBank();
    const first = await service.prepare(request, USER);
    repo.rows.get(first.id).destinationBank = 'Banco Demo Cóndor';

    const again = await service.prepare({ ...request }, USER);
    expect(again.id).toBe(first.id);
    expect(repo.rows.size).toBe(1);
  });

  it('la misma clave con una entidad distinta sí da 409', async () => {
    const { service } = setup();
    const request = toBank();
    await service.prepare(request, USER);

    await expect(service.prepare({ ...request, destinationBank: 'Banco Altamar' }, USER)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('Listar transferencias', () => {
  it('solo devuelve las del cliente', async () => {
    const { service } = setup();
    await service.prepare(dto(), USER);
    await service.prepare(dto(), OTHER_USER);

    const list = await service.list(USER);
    expect(list).toHaveLength(1);
    expect(list[0].sourceAccountId).toBe(SOURCE);
  });
});

describe('Métricas: transfers_total', () => {
  async function prepared(request = dto()) {
    const ctx = setup();
    const { id } = await ctx.service.prepare(request, USER);
    return { ...ctx, id };
  }
  const http = (status: number, message: string) => new HttpException({ statusCode: status, message }, status);

  describe('completadas', () => {
    it('se cuenta una vez, cuando el dinero se movió y la solicitud quedó completada', async () => {
      const { service, id, metricsService } = await prepared();
      expect(await counted(metricsService)).toEqual({});

      await service.confirm(id, USER, TOKEN, '123456');

      expect(await counted(metricsService)).toEqual({ 'completed:none': 1 });
    });

    it('confirmar otra vez una solicitud ya completada no la cuenta de nuevo', async () => {
      const { service, id, metricsService } = await prepared();
      await service.confirm(id, USER, TOKEN, '123456');
      await service.confirm(id, USER, TOKEN, '123456');

      expect(await counted(metricsService)).toEqual({ 'completed:none': 1 });
    });

    it('a otro banco también cuenta como completada', async () => {
      const { service, id, metricsService } = await prepared(toBank());
      await service.confirm(id, USER, TOKEN, '123456');

      expect(await counted(metricsService)).toEqual({ 'completed:none': 1 });
    });

    it('si el ledger falla sin dar una respuesta de negocio, la solicitud vuelve a pendiente y no cuenta; al reintentar sí', async () => {
      const { service, clients, id, metricsService } = await prepared();
      clients.transfer.mockRejectedValueOnce(new Error('ledger no responde'));
      await expect(service.confirm(id, USER, TOKEN, '123456')).rejects.toThrow();
      expect(await counted(metricsService)).toEqual({});

      await service.confirm(id, USER, TOKEN, '123456');

      expect(await counted(metricsService)).toEqual({ 'completed:none': 1 });
    });
  });

  describe('rechazos al preparar', () => {
    it('invalid_destination: número de cuenta, celular, tipo de cuenta o nombre inválidos', async () => {
      const { service, metricsService } = setup();
      const billetera = { destinationBank: 'Billetera Pulso', destinationAccountType: undefined };
      await expect(service.prepare(dto({ destinationAccountNumber: '123' }), USER)).rejects.toThrow();
      await expect(
        service.prepare(toBank({ ...billetera, destinationAccountNumber: '2001234567' }), USER),
      ).rejects.toThrow();
      await expect(service.prepare(toBank({ destinationAccountNumber: '12' }), USER)).rejects.toThrow();
      await expect(service.prepare(toBank({ destinationAccountType: undefined }), USER)).rejects.toThrow();
      await expect(service.prepare(toBank({ recipientName: ' Al ' }), USER)).rejects.toThrow();

      expect(await counted(metricsService)).toEqual({ 'rejected:invalid_destination': 5 });
    });

    it('key_not_found: la llave no existe (400 o 404 de account-service); si account-service no responde, no es un rechazo', async () => {
      const { service, clients, metricsService } = setup();
      const porLlave = () => dto({ destinationAccountNumber: undefined, destinationKey: 'nadie@correo.com' });
      clients.resolveKey.mockRejectedValueOnce(http(404, 'No encontramos esa llave en Banklite.'));
      clients.resolveKey.mockRejectedValueOnce(http(400, 'Llave inválida.'));
      clients.resolveKey.mockRejectedValueOnce(new ServiceUnavailableException('No se pudo consultar la llave.'));
      for (let i = 0; i < 3; i++) await expect(service.prepare(porLlave(), USER)).rejects.toThrow();

      expect(await counted(metricsService)).toEqual({ 'rejected:key_not_found': 2 });
    });

    it('not_owner, account_inactive y account_not_found: la cuenta de origen', async () => {
      const { service, clients, metricsService } = setup();
      clients.sourceAccount.mockResolvedValueOnce({ idUser: OTHER_USER, accountType: 'savings', status: 'active' });
      clients.sourceAccount.mockResolvedValueOnce({ idUser: USER, accountType: 'merchant', status: 'active' });
      clients.sourceAccount.mockResolvedValueOnce({ idUser: USER, accountType: 'savings', status: 'blocked' });
      clients.sourceAccount.mockRejectedValueOnce(new NotFoundException('Cuenta de origen no encontrada.'));
      clients.sourceAccount.mockRejectedValueOnce(new ServiceUnavailableException('No se pudo validar tu cuenta.'));
      for (let i = 0; i < 5; i++) await expect(service.prepare(toBank(), USER)).rejects.toThrow();

      expect(await counted(metricsService)).toEqual({
        'rejected:not_owner': 2,
        'rejected:account_inactive': 1,
        'rejected:account_not_found': 1,
      });
    });

    it('idempotency_conflict: la clave ya se usó para otro monto, destino o usuario', async () => {
      const { service, metricsService } = setup();
      const request = dto();
      await service.prepare(request, USER);
      await expect(service.prepare({ ...request, amount: 2000 }, USER)).rejects.toBeInstanceOf(ConflictException);
      await expect(service.prepare({ ...request }, OTHER_USER)).rejects.toBeInstanceOf(ConflictException);

      expect(await counted(metricsService)).toEqual({ 'rejected:idempotency_conflict': 2 });
    });

    it('preparar bien, repetir la misma solicitud, listar y cancelar no son rechazos', async () => {
      const { service, metricsService } = setup();
      const request = dto();
      const { id } = await service.prepare(request, USER);
      await service.prepare({ ...request }, USER);
      await service.list(USER);
      await service.cancel(id, USER);
      await service.cancel(id, USER);

      expect(await counted(metricsService)).toEqual({});
    });
  });

  describe('rechazos al confirmar', () => {
    it('request_not_found, request_cancelled y already_processing', async () => {
      const { service, repo, id, metricsService } = await prepared();
      await expect(service.confirm(randomUUID(), USER, TOKEN, '123456')).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.confirm(id, OTHER_USER, TOKEN, '123456')).rejects.toBeInstanceOf(NotFoundException);
      repo.rows.get(id).status = 'processing';
      await expect(service.confirm(id, USER, TOKEN, '123456')).rejects.toBeInstanceOf(ConflictException);
      repo.rows.get(id).status = 'cancelled';
      await expect(service.confirm(id, USER, TOKEN, '123456')).rejects.toBeInstanceOf(ConflictException);

      expect(await counted(metricsService)).toEqual({
        'rejected:request_not_found': 2,
        'rejected:already_processing': 1,
        'rejected:request_cancelled': 1,
      });
    });

    it('dynamic_key_invalid: clave dinámica incorrecta o bloqueada; si auth no responde, no es un rechazo', async () => {
      const { service, clients, id, metricsService } = await prepared();
      clients.verifyDynamicKey.mockRejectedValueOnce(new BadRequestException('Clave dinámica incorrecta o vencida.'));
      clients.verifyDynamicKey.mockRejectedValueOnce(http(429, 'Demasiados intentos.'));
      clients.verifyDynamicKey.mockRejectedValueOnce(new ServiceUnavailableException('No se pudo validar la clave.'));
      for (let i = 0; i < 3; i++) await expect(service.confirm(id, USER, TOKEN, '000000')).rejects.toThrow();

      expect(await counted(metricsService)).toEqual({ 'rejected:dynamic_key_invalid': 2 });
      expect(clients.transfer).not.toHaveBeenCalled();
    });

    it.each([
      [400, 'Saldo insuficiente.', 'insufficient_funds'],
      [403, 'La operación supera el límite diario de la cuenta.', 'limit_exceeded'],
      [403, 'La operación supera el límite mensual de la cuenta.', 'limit_exceeded'],
      [400, 'La cuenta de origen no está activa.', 'account_inactive'],
      [400, 'Las cuentas deben usar la misma moneda.', 'ledger_rejected'],
      [409, 'La clave de idempotencia ya se usó para otra operación.', 'ledger_rejected'],
    ])('el ledger responde %i «%s» → rejected:%s', async (status, message, reason) => {
      const { service, clients, repo, id, metricsService } = await prepared();
      clients.transfer.mockRejectedValueOnce(http(status, message));

      await expect(service.confirm(id, USER, TOKEN, '123456')).rejects.toBeInstanceOf(HttpException);

      expect(await counted(metricsService)).toEqual({ [`rejected:${reason}`]: 1 });
      // la solicitud sigue pendiente: se puede reintentar
      expect(repo.rows.get(id).status).toBe('pending');
    });

    it('a otro banco el rechazo del ledger también se cuenta', async () => {
      const { service, clients, id, metricsService } = await prepared(toBank());
      clients.debitToClearing.mockRejectedValueOnce(http(400, 'Saldo insuficiente.'));

      await expect(service.confirm(id, USER, TOKEN, '123456')).rejects.toBeInstanceOf(HttpException);

      expect(await counted(metricsService)).toEqual({ 'rejected:insufficient_funds': 1 });
    });

    it('un 401 (sesión vencida), un 5xx, la falta de respuesta o un error inesperado NO son rechazos de negocio', async () => {
      const { service, clients, id, metricsService } = await prepared();
      clients.transfer.mockRejectedValueOnce(http(401, 'Token inválido o expirado'));
      clients.transfer.mockRejectedValueOnce(new ServiceUnavailableException('No se pudo completar la transferencia.'));
      clients.transfer.mockRejectedValueOnce(http(500, 'Error interno'));
      clients.transfer.mockRejectedValueOnce(new Error('ECONNRESET'));
      for (let i = 0; i < 4; i++) await expect(service.confirm(id, USER, TOKEN, '123456')).rejects.toThrow();

      expect(await counted(metricsService)).toEqual({});
    });

    it('un rechazo seguido de un reintento exitoso cuenta una rechazada y una completada', async () => {
      const { service, clients, id, metricsService } = await prepared();
      clients.transfer.mockRejectedValueOnce(http(400, 'Saldo insuficiente.'));
      await expect(service.confirm(id, USER, TOKEN, '123456')).rejects.toThrow();

      await service.confirm(id, USER, TOKEN, '123456');

      expect(await counted(metricsService)).toEqual({ 'rejected:insufficient_funds': 1, 'completed:none': 1 });
    });
  });

  describe('contar nunca rompe una transferencia', () => {
    /** Hace que prom-client lance en cada inc(), como si el registro estuviera dañado. */
    function breakCounter(metricsService: MetricsService) {
      const counter = metricsService.registry.getSingleMetric('transfers_total') as Counter;
      return jest.spyOn(counter, 'inc').mockImplementation(() => {
        throw new Error('prom-client roto');
      });
    }

    it('si contar lanza, la transferencia se completa igual y el cliente recibe la solicitud completada', async () => {
      const { service, clients, repo, id, metricsService } = await prepared();
      const inc = breakCounter(metricsService);

      const result = await service.confirm(id, USER, TOKEN, '123456');

      expect(inc).toHaveBeenCalled();
      expect(result).toMatchObject({ status: 'completed', ledgerTransactionId: 'tx-banklite' });
      expect(repo.rows.get(id).status).toBe('completed');
      expect(clients.transfer).toHaveBeenCalledTimes(1);
    });

    it('si contar lanza, un rechazo llega al cliente con su error original (no con el de la métrica)', async () => {
      const { service, clients, repo, id, metricsService } = await prepared();
      breakCounter(metricsService);
      clients.transfer.mockRejectedValueOnce(http(400, 'Saldo insuficiente.'));

      const error = await service.confirm(id, USER, TOKEN, '123456').catch((e) => e);

      expect(error).toBeInstanceOf(HttpException);
      expect(error.getStatus()).toBe(400);
      expect(error.message).toContain('Saldo insuficiente');
      expect(repo.rows.get(id).status).toBe('pending');
    });

    it('si contar lanza, los rechazos de prepare y de confirm siguen dando su error de siempre', async () => {
      const { service, clients, id, metricsService } = await prepared();
      breakCounter(metricsService);
      clients.verifyDynamicKey.mockRejectedValueOnce(new BadRequestException('Clave dinámica incorrecta o vencida.'));
      clients.resolveKey.mockRejectedValueOnce(http(404, 'No encontramos esa llave en Banklite.'));
      clients.sourceAccount.mockResolvedValueOnce({ idUser: OTHER_USER, accountType: 'savings', status: 'active' });

      await expect(service.confirm(id, USER, TOKEN, '000000')).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.confirm(randomUUID(), USER, TOKEN, '123456')).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.prepare(dto({ destinationAccountNumber: '12' }), USER)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(
        service.prepare(dto({ destinationAccountNumber: undefined, destinationKey: 'nadie@correo.com' }), USER),
      ).rejects.toMatchObject({ status: 404 });
      await expect(service.prepare(toBank(), USER)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('TransferMetrics: ni completed() ni rejected() lanzan, y avisan en el log', () => {
      const metricsService = new MetricsService(new ConfigService({}));
      const metrics = new TransferMetrics(metricsService);
      const counter = metricsService.registry.getSingleMetric('transfers_total') as Counter;
      jest.spyOn(counter, 'inc').mockImplementation(() => {
        throw new Error('roto');
      });
      const aviso = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      expect(() => metrics.completed()).not.toThrow();
      expect(() => metrics.rejected('insufficient_funds')).not.toThrow();

      expect(aviso).toHaveBeenCalledTimes(2);
      aviso.mockRestore();
    });

    it('si la métrica no se pudo crear (nombre duplicado), el servicio arranca y contar no hace nada', () => {
      const metricsService = new MetricsService(new ConfigService({}));
      new TransferMetrics(metricsService);

      const segunda = new TransferMetrics(metricsService); // transfers_total ya estaba registrada

      expect(() => segunda.completed()).not.toThrow();
      expect(() => segunda.rejected('ledger_rejected')).not.toThrow();
    });
  });

  describe('etiquetas: lista cerrada, sin datos sensibles', () => {
    it('las series existen desde el arranque en 0 y solo hay result y reason', async () => {
      const { metricsService } = setup();
      const text = await metricsService.registry.getSingleMetric('transfers_total').get();
      const series = text.values.map((v) => `${v.labels.result}:${v.labels.reason}`);

      expect(series).toHaveLength(TRANSFER_REJECTIONS.length + 1);
      expect(series).toContain('completed:none');
      for (const reason of TRANSFER_REJECTIONS) expect(series).toContain(`rejected:${reason}`);
      for (const v of text.values) expect(Object.keys(v.labels).sort()).toEqual(['reason', 'result']);
    });

    it('tras un flujo con ids, cuentas, montos, correos y mensajes de error, ninguno aparece en la métrica', async () => {
      const { service, clients, metricsService } = setup();
      const llave = dto({
        destinationAccountNumber: undefined,
        destinationKey: 'ana.perez@example.com',
        amount: 987654,
      });
      const { id } = await service.prepare(llave, USER);
      clients.transfer.mockRejectedValueOnce(
        http(400, 'Saldo insuficiente. Cuenta 10000000002 de ana.perez@example.com'),
      );
      await expect(service.confirm(id, USER, TOKEN, '123456')).rejects.toThrow();
      clients.sourceAccount.mockResolvedValueOnce({ idUser: OTHER_USER, accountType: 'savings', status: 'active' });
      await expect(service.prepare(toBank({ destinationAccountNumber: '98765432' }), USER)).rejects.toThrow();
      await service.confirm(id, USER, TOKEN, '123456');

      const text = await metricsService.registry.metrics();
      const lineas = text.split('\n').filter((l) => l.startsWith('transfers_total'));
      const etiquetas = lineas.map((l) => l.slice(l.indexOf('{'), l.indexOf('}') + 1)).join(' ');

      expect(lineas.length).toBe(TRANSFER_REJECTIONS.length + 1);
      for (const dato of [
        id,
        USER,
        OTHER_USER,
        SOURCE,
        '10000000002',
        '987654',
        '98765432',
        'ana.perez',
        '@',
        'example.com',
        'Saldo',
      ]) {
        expect(etiquetas).not.toContain(dato);
      }
      // Cada valor de `reason` es de la lista cerrada (o "none") y `result` solo toma dos valores.
      for (const m of etiquetas.matchAll(/reason="([^"]+)"/g)) expect(['none', ...TRANSFER_REJECTIONS]).toContain(m[1]);
      for (const m of etiquetas.matchAll(/result="([^"]+)"/g)) expect(['completed', 'rejected']).toContain(m[1]);
    });
  });
});
