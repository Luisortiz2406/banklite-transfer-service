import { Injectable } from '@nestjs/common';
import { Counter } from 'prom-client';
import { MetricsService } from './metrics.service';

/**
 * Motivos de rechazo de una transferencia: lista CERRADA. La etiqueta `reason` solo puede tomar estos
 * valores (nunca un mensaje de error, un id, una cuenta, un monto ni un correo). `none` es solo
 * para las completadas.
 */
export const TRANSFER_REJECTIONS = [
  'invalid_destination', // número de cuenta, tipo de cuenta o nombre de destino inválidos
  'key_not_found', // la llave Banklite no existe o no es válida
  'not_owner', // la cuenta de origen no es del cliente (o es de un comercio)
  'account_not_found', // la cuenta de origen no existe
  'account_inactive', // la cuenta (origen o destino) no está activa
  'idempotency_conflict', // la clave de idempotencia ya se usó para otra solicitud
  'request_not_found', // la solicitud que se quiere confirmar no existe o no es del cliente
  'request_cancelled', // la solicitud fue cancelada
  'already_processing', // la solicitud ya se está procesando
  'dynamic_key_invalid', // clave dinámica incorrecta, vencida o bloqueada
  'insufficient_funds', // el ledger rechazó por saldo insuficiente
  'limit_exceeded', // el ledger rechazó por superar el límite diario o mensual
  'ledger_rejected', // el ledger rechazó por otra regla de negocio (4xx)
] as const;
export type TransferRejection = (typeof TRANSFER_REJECTIONS)[number];

/**
 * transfers_total{result,reason}: transferencias de transfer-service.
 *   - result="completed" (reason="none"): el dinero se movió en el ledger y la solicitud quedó completada.
 *   - result="rejected" (reason=<motivo de la lista cerrada>): una solicitud o confirmación que el
 *     servicio o el ledger rechazó con un 4xx de negocio.
 * Los fallos de infraestructura (5xx, sin respuesta) NO cuentan: la solicitud vuelve a pendiente y se
 * reintenta; quedan en http_requests_total con su código de estado.
 */
@Injectable()
export class TransferMetrics {
  private readonly transfers: Counter<'result' | 'reason'>;

  constructor(metrics: MetricsService) {
    this.transfers = new Counter({
      name: 'transfers_total',
      help: 'Transferencias completadas y rechazadas, con el motivo del rechazo (lista cerrada).',
      labelNames: ['result', 'reason'],
      registers: [metrics.registry],
    });
    // Todas las series existen desde el arranque (en 0): así increase() y rate() ven el primer evento.
    this.transfers.inc({ result: 'completed', reason: 'none' }, 0);
    for (const reason of TRANSFER_REJECTIONS) this.transfers.inc({ result: 'rejected', reason }, 0);
  }

  completed() {
    this.transfers.inc({ result: 'completed', reason: 'none' });
  }

  rejected(reason: TransferRejection) {
    this.transfers.inc({ result: 'rejected', reason });
  }
}
