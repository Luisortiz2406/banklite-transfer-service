import {
  BadRequestException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { callService, HTTP_TIMEOUTS } from '../common/http/internal-http';

export interface SourceAccountInfo {
  id: string;
  idUser: string;
  accountType: string;
  status: string;
}

export interface ResolvedKey {
  accountNumber: string;
  key: string;
  holderName: string;
}

const LEDGER_UNAVAILABLE = 'No se pudo completar la transferencia en este momento. Puedes reintentar la confirmación.';

/**
 * Llamadas de transfer-service a otros servicios: clave dinámica (auth), cuenta
 * de origen y llaves Bre-B (account) y asientos (ledger). Solo HTTP: las reglas
 * de negocio (dueño, estado, idempotencia) están en TransfersService.
 * Errores: regla común de common/http/internal-http.ts.
 */
@Injectable()
export class TransferClientsService {
  constructor(private readonly config: ConfigService) {}

  /** Valida la clave dinámica con Auth Service (red interna). */
  async verifyDynamicKey(userId: string, code: string): Promise<void> {
    const payload = await callService<{ valid?: boolean; message?: string }>(
      `${this.url('AUTH_SERVICE_URL', 'http://localhost:3001')}/internal/dynamic-key/verify`,
      { method: 'POST', headers: this.internalHeaders(), body: JSON.stringify({ idUser: userId, code }) },
      {
        service: 'Auth Service',
        internal: true,
        unavailable: 'No se pudo validar la clave dinámica. Inténtalo de nuevo.',
      },
    );
    if (payload?.valid !== true) {
      throw new BadRequestException(payload?.message || 'Clave dinámica incorrecta o vencida.');
    }
  }

  /** Titular, tipo y estado de la cuenta de origen (account-service, red interna). */
  async sourceAccount(accountId: string): Promise<SourceAccountInfo> {
    return callService<SourceAccountInfo>(
      `${this.url('ACCOUNT_SERVICE_URL', 'http://localhost:3002')}/internal/accounts/${encodeURIComponent(accountId)}/ledger-info`,
      { headers: this.internalHeaders(), timeoutMs: HTTP_TIMEOUTS.read, retry: true },
      {
        service: 'Account Service',
        internal: true,
        unavailable: 'No se pudo validar tu cuenta. Inténtalo de nuevo.',
        on: { 404: () => new NotFoundException('Cuenta de origen no encontrada.') },
      },
    );
  }

  /** Cuenta destino de una llave Bre-B (account-service, red interna). */
  async resolveKey(rawKey: string): Promise<ResolvedKey> {
    const notFound = (status: number) => (r: { message: string }) =>
      new HttpException(r.message || 'No encontramos esa llave en Banklite.', status);
    return callService<ResolvedKey>(
      `${this.url('ACCOUNT_SERVICE_URL', 'http://localhost:3002')}/internal/accounts/keys/resolve?key=${encodeURIComponent(rawKey)}`,
      { headers: this.internalHeaders(), timeoutMs: HTTP_TIMEOUTS.read, retry: true },
      {
        service: 'Account Service',
        internal: true,
        unavailable: 'No se pudo consultar la llave Bre-B. Inténtalo de nuevo.',
        on: { 400: notFound(400), 404: notFound(404) },
      },
    );
  }

  /** Entre cuentas Banklite: transferencia en el ledger con el token del cliente. */
  async transfer(
    body: {
      sourceAccountId: string;
      destinationAccountNumber: string;
      amount: number;
      description: string;
      idempotencyKey: string;
    },
    accessToken: string,
  ): Promise<{ id?: string }> {
    return callService<{ id?: string }>(
      `${this.url('LEDGER_SERVICE_URL', 'http://localhost:3006')}/ledger/transfers`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs: HTTP_TIMEOUTS.slow,
      },
      { service: 'Ledger Service', internal: false, unavailable: LEDGER_UNAVAILABLE },
    );
  }

  /** A otro banco: cargo hacia la cuenta de compensación (ledger, red interna). */
  async debitToClearing(body: {
    accountId: string;
    amount: number;
    description: string;
    idempotencyKey: string;
  }): Promise<{ id?: string }> {
    return callService<{ id?: string }>(
      `${this.url('LEDGER_SERVICE_URL', 'http://localhost:3006')}/ledger/internal/debits`,
      {
        method: 'POST',
        headers: this.internalHeaders(),
        body: JSON.stringify(body),
        timeoutMs: HTTP_TIMEOUTS.slow,
      },
      { service: 'Ledger Service', internal: true, unavailable: LEDGER_UNAVAILABLE },
    );
  }

  private url(key: string, fallback: string) {
    return this.config.get<string>(key, fallback).replace(/\/+$/, '');
  }

  private internalHeaders() {
    const key = this.config.get<string>('INTERNAL_API_KEY');
    if (!key) throw new ServiceUnavailableException('INTERNAL_API_KEY no está configurada en Transfer Service.');
    return { 'Content-Type': 'application/json', 'x-internal-key': key };
  }
}
