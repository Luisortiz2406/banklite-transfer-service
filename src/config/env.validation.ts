/**
 * Validación de la configuración al arrancar. El servicio NO levanta si falta
 * un secreto, si es demasiado corto, si sigue siendo un valor de ejemplo del
 * repositorio o si se reutiliza el mismo valor para dos propósitos distintos.
 * Así es imposible desplegar con los secretos públicos del repo, aunque se
 * olvide configurar una variable en Railway o en el .env.
 *
 * Este archivo es idéntico en todos los microservicios.
 */
const MIN_SECRET_LENGTH = 32;
const PLACEHOLDER = /cambiar|reemplazar|replace|changeme|example|ejemplo|secreto/i;
const HEX64 = /^[0-9a-fA-F]{64}$/;
// Credenciales de ejemplo de docker-compose (usuario banklite / clave banklite).
const DEFAULT_CREDENTIALS = /\/\/banklite:banklite@/i;
const CALLER_NAME = /^[a-z][a-z0-9-]*$/;

export type EnvRule =
  /** Secreto aleatorio de 32+ caracteres. */
  | { key: string; type: 'secret' }
  /** Llave AES-256 en hexadecimal (64 caracteres). */
  | { key: string; type: 'hex64' }
  /** Claves internas aceptadas, "servicio:clave,servicio:clave". */
  | { key: string; type: 'trusted-keys'; optional?: boolean }
  /** URL de conexión (Postgres, RabbitMQ) sin las credenciales de ejemplo. */
  | { key: string; type: 'url'; optional?: boolean };

export interface TrustedKey {
  caller: string;
  key: string;
}

/** Interpreta INTERNAL_TRUSTED_KEYS. Lanza un error si el formato o una clave no son válidos. */
export function parseTrustedKeys(raw: string | undefined): TrustedKey[] {
  const entries = (raw ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  return entries.map((entry) => {
    const sep = entry.indexOf(':');
    const caller = sep > 0 ? entry.slice(0, sep).trim() : '';
    const key = sep > 0 ? entry.slice(sep + 1).trim() : '';
    if (!CALLER_NAME.test(caller) || !key) {
      throw new Error('INTERNAL_TRUSTED_KEYS debe tener el formato "servicio:clave,servicio:clave".');
    }
    const problem = secretProblem(key);
    if (problem) throw new Error(`INTERNAL_TRUSTED_KEYS (${caller}): ${problem}`);
    return { caller, key };
  });
}

function secretProblem(value: string): string | null {
  if (value.length < MIN_SECRET_LENGTH) return `debe tener al menos ${MIN_SECRET_LENGTH} caracteres.`;
  if (PLACEHOLDER.test(value)) return 'sigue siendo un valor de ejemplo; genera uno aleatorio.';
  return null;
}

/**
 * Para ConfigModule.forRoot({ validate }). `distinct`: claves que no pueden
 * compartir valor entre sí (p. ej. JWT_SECRET y STAFF_JWT_SECRET).
 */
export function validateEnv(rules: EnvRule[], distinct: string[] = []) {
  return (config: Record<string, unknown>) => {
    const errors: string[] = [];
    const read = (key: string) => (typeof config[key] === 'string' ? (config[key] as string).trim() : '');

    for (const rule of rules) {
      const value = read(rule.key);
      if (!value) {
        if (!('optional' in rule && rule.optional)) errors.push(`${rule.key} es obligatoria.`);
        continue;
      }
      if (rule.type === 'secret') {
        const problem = secretProblem(value);
        if (problem) errors.push(`${rule.key} ${problem}`);
      } else if (rule.type === 'hex64') {
        if (!HEX64.test(value)) errors.push(`${rule.key} debe tener exactamente 64 caracteres hexadecimales.`);
      } else if (rule.type === 'trusted-keys') {
        try {
          const keys = parseTrustedKeys(value).map((k) => k.key);
          if (new Set(keys).size !== keys.length) errors.push(`${rule.key}: cada servicio debe tener su propia clave.`);
        } catch (err) {
          errors.push((err as Error).message);
        }
      } else if (rule.type === 'url') {
        if (DEFAULT_CREDENTIALS.test(value))
          errors.push(`${rule.key} usa las credenciales de ejemplo (banklite/banklite).`);
      }
    }

    const seen = new Map<string, string>();
    for (const key of distinct) {
      const value = read(key);
      if (!value) continue;
      const other = seen.get(value);
      if (other) errors.push(`${key} y ${other} no pueden tener el mismo valor.`);
      else seen.set(value, key);
    }

    if (errors.length) {
      throw new Error(`Configuración insegura, el servicio no arranca:\n - ${errors.join('\n - ')}`);
    }
    return config;
  };
}
