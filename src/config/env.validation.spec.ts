import { parseTrustedKeys, validateEnv } from './env.validation';

// Prueba la regla común de env.validation.ts (idéntico en todos los servicios): el
// servicio no arranca con secretos de ejemplo, cortos o repetidos.

const SECRET_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const SECRET_B = 'f0e1d2c3b4a5968778695a4b3c2d1e0f';
const HEX = '0123456789abcdef'.repeat(4);

describe('parseTrustedKeys', () => {
  it('vacío o sin definir no confía en nadie', () => {
    expect(parseTrustedKeys(undefined)).toEqual([]);
    expect(parseTrustedKeys(' , ')).toEqual([]);
  });

  it('lee "servicio:clave" separados por coma', () => {
    expect(parseTrustedKeys(`transfer:${SECRET_A}, card:${SECRET_B}`)).toEqual([
      { caller: 'transfer', key: SECRET_A },
      { caller: 'card', key: SECRET_B },
    ]);
  });

  it('rechaza un formato roto, un nombre inválido o una clave débil', () => {
    expect(() => parseTrustedKeys(SECRET_A)).toThrow('formato');
    expect(() => parseTrustedKeys(`Transfer:${SECRET_A}`)).toThrow('formato');
    expect(() => parseTrustedKeys('transfer:')).toThrow('formato');
    expect(() => parseTrustedKeys('transfer:corta')).toThrow('al menos 32');
    expect(() => parseTrustedKeys(`transfer:${'cambiar-esta-clave-'.repeat(2)}`)).toThrow('ejemplo');
  });
});

describe('validateEnv', () => {
  const rules = [
    { key: 'JWT_SECRET', type: 'secret' as const },
    { key: 'STAFF_JWT_SECRET', type: 'secret' as const },
    { key: 'ENCRYPTION_KEY', type: 'hex64' as const },
    { key: 'INTERNAL_TRUSTED_KEYS', type: 'trusted-keys' as const, optional: true },
    { key: 'DATABASE_URL', type: 'url' as const, optional: true },
  ];
  const valid = {
    JWT_SECRET: SECRET_A,
    STAFF_JWT_SECRET: SECRET_B,
    ENCRYPTION_KEY: HEX,
    INTERNAL_TRUSTED_KEYS: `transfer:${SECRET_A},card:${SECRET_B}`,
    DATABASE_URL: 'postgres://usuario:clave-larga@db:5432/banklite',
  };
  const check = (config: Record<string, unknown>) => validateEnv(rules, ['JWT_SECRET', 'STAFF_JWT_SECRET'])(config);

  it('acepta una configuración válida y la devuelve igual', () => {
    expect(check(valid)).toBe(valid);
    expect(check({ ...valid, INTERNAL_TRUSTED_KEYS: undefined, DATABASE_URL: undefined })).toBeTruthy();
  });

  it('falta una variable obligatoria', () => {
    expect(() => check({ ...valid, JWT_SECRET: undefined })).toThrow('JWT_SECRET es obligatoria');
    expect(() => check({ ...valid, JWT_SECRET: '   ' })).toThrow('JWT_SECRET es obligatoria');
  });

  it('un secreto corto o de ejemplo no pasa', () => {
    expect(() => check({ ...valid, JWT_SECRET: 'corto' })).toThrow('al menos 32');
    expect(() => check({ ...valid, JWT_SECRET: 'reemplazar-por-un-secreto-aleatorio-largo' })).toThrow('ejemplo');
  });

  it('la llave de cifrado debe ser hexadecimal de 64 caracteres', () => {
    expect(() => check({ ...valid, ENCRYPTION_KEY: 'zz'.repeat(32) })).toThrow('64 caracteres hexadecimales');
    expect(() => check({ ...valid, ENCRYPTION_KEY: HEX.slice(2) })).toThrow('64 caracteres hexadecimales');
  });

  it('las claves internas: formato válido y una distinta por servicio', () => {
    expect(() => check({ ...valid, INTERNAL_TRUSTED_KEYS: 'sin-formato' })).toThrow('formato');
    expect(() => check({ ...valid, INTERNAL_TRUSTED_KEYS: `a:${SECRET_A},b:${SECRET_A}` })).toThrow(
      'cada servicio debe tener su propia clave',
    );
  });

  it('la base de datos no puede usar las credenciales de ejemplo', () => {
    expect(() => check({ ...valid, DATABASE_URL: 'postgres://banklite:banklite@db:5432/banklite' })).toThrow(
      'credenciales de ejemplo',
    );
  });

  it('el JWT de clientes y el de empleados no pueden compartir valor', () => {
    expect(() => check({ ...valid, STAFF_JWT_SECRET: SECRET_A })).toThrow('no pueden tener el mismo valor');
  });

  it('junta todos los problemas en un solo error', () => {
    try {
      check({ JWT_SECRET: 'corto' });
      throw new Error('no lanzó');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('el servicio no arranca');
      expect(message).toContain('JWT_SECRET');
      expect(message).toContain('STAFF_JWT_SECRET es obligatoria');
      expect(message).toContain('ENCRYPTION_KEY es obligatoria');
    }
  });
});
