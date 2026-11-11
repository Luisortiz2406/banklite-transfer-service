import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PrepareTransferDto } from './prepare-transfer.dto';

const VALID = {
  sourceAccountId: '33333333-3333-4333-8333-333333333333',
  destinationAccountNumber: '10000000002',
  amount: 1500,
  idempotencyKey: '44444444-4444-4444-8444-444444444444',
};

async function errors(body: Record<string, unknown>): Promise<string[]> {
  const result = await validate(plainToInstance(PrepareTransferDto, body));
  return result.map((error) => error.property);
}

describe('Validación de PrepareTransferDto', () => {
  it('acepta una transferencia válida a una cuenta y otra con llave', async () => {
    expect(await errors(VALID)).toEqual([]);
    expect(await errors({ ...VALID, destinationAccountNumber: undefined, destinationKey: 'ana@correo.com' })).toEqual(
      [],
    );
  });

  it('exige un monto mínimo de $1.000 y como mucho 2 decimales', async () => {
    expect(await errors({ ...VALID, amount: 999.99 })).toEqual(['amount']);
    expect(await errors({ ...VALID, amount: 1000.001 })).toEqual(['amount']);
    expect(await errors({ ...VALID, amount: 1000 })).toEqual([]);
  });

  it('exige UUID en la cuenta de origen y en la clave de idempotencia', async () => {
    expect(await errors({ ...VALID, sourceAccountId: 'cuenta-1' })).toEqual(['sourceAccountId']);
    expect(await errors({ ...VALID, idempotencyKey: '123' })).toEqual(['idempotencyKey']);
  });

  it('exige un número de cuenta o una llave', async () => {
    const result = await errors({ ...VALID, destinationAccountNumber: undefined });
    expect(result).toEqual(expect.arrayContaining(['destinationAccountNumber', 'destinationKey']));
  });

  it('el número de cuenta solo puede tener dígitos', async () => {
    expect(await errors({ ...VALID, destinationAccountNumber: '1000-0000-02' })).toEqual(['destinationAccountNumber']);
  });

  it('rechaza una entidad o un tipo de cuenta que no están en la lista', async () => {
    expect(await errors({ ...VALID, destinationBank: 'Banco Inventado' })).toEqual(['destinationBank']);
    expect(await errors({ ...VALID, destinationBank: 'Banco Cordillera', destinationAccountType: 'Nómina' })).toEqual([
      'destinationAccountType',
    ]);
  });

  it('acepta todas las entidades vigentes y todavía los nombres anteriores', async () => {
    for (const bank of ['Banco Cordillera', 'Banco Sabanal', 'Billetera Pulso', 'Billetera Brío', 'Otra entidad']) {
      expect(await errors({ ...VALID, destinationBank: bank })).toEqual([]);
    }
    for (const bank of ['Banco Demo Cóndor', 'Billetera Demo Tucán']) {
      expect(await errors({ ...VALID, destinationBank: bank })).toEqual([]);
    }
  });
});
