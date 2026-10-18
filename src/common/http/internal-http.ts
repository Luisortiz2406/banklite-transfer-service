import { HttpException, Logger, ServiceUnavailableException } from '@nestjs/common';

/**
 * Llamadas HTTP entre servicios de BankLite: tiempos máximos y una sola regla de
 * errores. Este archivo es idéntico en todos los servicios que llaman a otros.
 */

/** Tiempo máximo de cada llamada, en milisegundos. */
export const HTTP_TIMEOUTS = {
  /** Lecturas (se reintentan una vez si el otro servicio no responde). */
  read: 4_000,
  /** Validaciones y escrituras. */
  write: 10_000,
  /** Asientos del ledger y envíos por WhatsApp: pueden tardar más. */
  slow: 15_000,
} as const;

const READ_RETRIES = Number(process.env.HTTP_READ_RETRIES ?? 1);
const RETRY_DELAY_MS = 300;
const RETRYABLE_STATUS = new Set([502, 503, 504]);
const logger = new Logger('InternalHttp');

export interface ServiceResponse<T = any> {
  status: number;
  ok: boolean;
  body: T;
  /** Mensaje del otro servicio (los de validación vienen en lista y se unen). */
  message: string;
}

export interface RequestOptions extends RequestInit {
  timeoutMs?: number;
  /** Solo para lecturas: reintenta si no hay respuesta o llega 502/503/504. */
  retry?: boolean;
}

/**
 * Hace la petición. Devuelve null si no hubo respuesta (red caída o tiempo
 * agotado). No lanza excepciones: quien llama decide, normalmente con expectOk.
 */
export async function requestService<T = any>(
  url: string,
  options: RequestOptions = {},
): Promise<ServiceResponse<T> | null> {
  const { timeoutMs = HTTP_TIMEOUTS.write, retry = false, ...init } = options;
  const attempts = retry ? READ_RETRIES + 1 : 1;
  for (let attempt = 1; ; attempt++) {
    let response: Response | null = null;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      // sin respuesta: red caída o tiempo agotado
    }
    const last = attempt >= attempts;
    if (response && (last || !RETRYABLE_STATUS.has(response.status))) {
      const body = await response.json().catch(() => ({}));
      return { status: response.status, ok: response.ok, body: body as T, message: messageOf(body) };
    }
    if (last) return null;
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * 3 ** (attempt - 1)));
  }
}

function messageOf(body: any): string {
  const message = body?.message;
  if (Array.isArray(message)) return message.join(', ');
  return typeof message === 'string' ? message : '';
}

export interface ExpectOptions {
  /** Nombre del servicio llamado, para el log. */
  service: string;
  /** true si la llamada usa la clave interna (x-internal-key) y no el token del cliente. */
  internal: boolean;
  /** Mensaje para el cliente cuando el otro servicio no está disponible. */
  unavailable?: string;
  /**
   * Traducción explícita de un estado (p. ej. 404 → mensaje de negocio). Si la
   * función devuelve undefined se aplica la regla común.
   */
  on?: Partial<Record<number, (response: ServiceResponse) => HttpException | undefined>>;
}

/**
 * Regla común para la respuesta de otro servicio:
 * - 2xx: devuelve el cuerpo.
 * - 4xx: se reenvía al cliente con el mismo estado y el mismo mensaje (un 403
 *   del ledger, p. ej. "supera el límite diario", es un rechazo de negocio).
 *   Excepción: un 401 a una llamada con clave interna significa que el otro
 *   servicio no aceptó nuestra INTERNAL_API_KEY (InternalKeyGuard). Es un
 *   problema de configuración, no de la sesión del cliente: se responde 503
 *   (reenviar el 401 haría que el frontend cerrara la sesión del cliente).
 * - 5xx o sin respuesta: 503 con un mensaje para reintentar.
 */
export function expectOk<T = any>(response: ServiceResponse<T> | null, options: ExpectOptions): T {
  const unavailable =
    options.unavailable ?? `${options.service} no está disponible en este momento. Inténtalo de nuevo.`;
  if (!response) {
    logger.warn(`${options.service} no respondió (red o tiempo agotado).`);
    throw new ServiceUnavailableException(unavailable);
  }
  if (response.ok) return response.body;

  const translated = options.on?.[response.status]?.(response);
  if (translated) throw translated;

  if (response.status >= 400 && response.status < 500) {
    if (options.internal && response.status === 401) {
      logger.error(
        `${options.service} rechazó la clave interna (401): revisa INTERNAL_API_KEY / INTERNAL_TRUSTED_KEYS.`,
      );
      throw new ServiceUnavailableException(unavailable);
    }
    throw new HttpException(
      { statusCode: response.status, message: response.message || `${options.service} rechazó la solicitud.` },
      response.status,
    );
  }
  logger.warn(`${options.service} respondió ${response.status}: ${response.message}`);
  throw new ServiceUnavailableException(unavailable);
}

/** requestService + expectOk: la forma normal de llamar a otro servicio. */
export async function callService<T = any>(url: string, request: RequestOptions, options: ExpectOptions): Promise<T> {
  return expectOk<T>(await requestService<T>(url, request), options);
}
