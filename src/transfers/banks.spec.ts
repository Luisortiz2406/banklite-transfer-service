import { ACCEPTED_BANKS, currentBankName, EXTERNAL_BANKS, WALLETS } from './banks';

describe('Entidades de otros bancos y billeteras', () => {
  it('currentBankName traduce los nombres anteriores y deja igual el resto', () => {
    expect(currentBankName('Banco Demo Cóndor')).toBe('Banco Cordillera');
    expect(currentBankName('Billetera Demo Tucán')).toBe('Billetera Brío');
    expect(currentBankName('Banco Cordillera')).toBe('Banco Cordillera');
    expect(currentBankName('Otra entidad')).toBe('Otra entidad');
    expect(currentBankName(null)).toBeNull();
  });

  it('todo nombre anterior se traduce a una entidad vigente', () => {
    const anteriores = ACCEPTED_BANKS.filter((name) => !(EXTERNAL_BANKS as readonly string[]).includes(name));
    expect(anteriores.length).toBeGreaterThan(0);
    for (const name of anteriores) {
      expect(EXTERNAL_BANKS as readonly string[]).toContain(currentBankName(name));
    }
  });

  it('las billeteras son entidades vigentes', () => {
    for (const wallet of WALLETS) expect(EXTERNAL_BANKS as readonly string[]).toContain(wallet);
  });
});
