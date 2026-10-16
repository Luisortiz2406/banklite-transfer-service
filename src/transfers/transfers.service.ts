import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PrepareTransferDto, WALLETS } from './dto/prepare-transfer.dto';
import { TransferRequest } from './entities/transfer-request.entity';

// Una confirmación que lleva más de esto en 'processing' se considera abandonada
// (p. ej. el servicio se reinició a mitad de camino) y puede reintentarse. Es
// seguro porque Ledger es idempotente por idempotencyKey: si la transferencia
// ya se registró, devuelve la misma transacción en vez de duplicarla.
const STALE_PROCESSING_MS = 60_000;

// Igual que account-service: correo y @llave en minúsculas; celular y cédula sin espacios, puntos ni guiones.
function normalizeKey(raw: string): string {
  const value = String(raw ?? '').trim();
  return value.includes('@') ? value.toLowerCase() : value.replace(/[\s.-]/g, '');
}

@Injectable()
export class TransfersService {
  constructor(
    @InjectRepository(TransferRequest) private readonly requests: Repository<TransferRequest>,
    private readonly config: ConfigService,
  ) {}

  async prepare(dto: PrepareTransferDto, userId: string) {
    const existing = await this.requests.findOne({ where: { idempotencyKey: dto.idempotencyKey } });
    if (existing) {
      this.assertSameRequest(existing, dto, userId);
      return this.publicRequest(existing);
    }

    let destination: { accountNumber: string; key: string | null; holderName: string | null };
    let external: Pick<TransferRequest, 'destinationBank' | 'destinationAccountType' | 'externalAccountNumber'> =
      { destinationBank: null, destinationAccountType: null, externalAccountNumber: null };
    if (dto.destinationBank) {
      // Otro banco o billetera: el dinero sale por la cuenta de compensación del
      // ledger, que no valida al titular; por eso se valida aquí que la cuenta sea suya.
      external = this.externalDestination(dto);
      await this.assertOwnAccount(dto.sourceAccountId, userId);
      destination = { accountNumber: '', key: null, holderName: dto.recipientName.trim() };
    } else if (dto.destinationKey) {
      // Con llave Bre-B, account-service dice a qué cuenta llega (por la red interna).
      destination = await this.resolveKey(dto.destinationKey);
    } else {
      if (!/^\d{11}$/.test(dto.destinationAccountNumber ?? '')) {
        throw new BadRequestException('El número de cuenta Banklite debe tener 11 dígitos.');
      }
      destination = { accountNumber: dto.destinationAccountNumber, key: null, holderName: null };
    }

    const request = this.requests.create({
      userId,
      sourceAccountId: dto.sourceAccountId,
      destinationAccountNumber: destination.accountNumber,
      destinationKey: destination.key,
      recipientName: destination.holderName,
      ...external,
      amount: dto.amount.toFixed(2),
      description: dto.description?.trim() || 'Transferencia',
      idempotencyKey: dto.idempotencyKey,
      status: 'pending',
      ledgerTransactionId: null,
    });
    try {
      return this.publicRequest(await this.requests.save(request));
    } catch (error) {
      if ((error as any)?.code !== '23505') throw error;
      const raced = await this.requests.findOne({ where: { idempotencyKey: dto.idempotencyKey } });
      if (!raced) throw new ConflictException('La solicitud ya está siendo procesada.');
      this.assertSameRequest(raced, dto, userId);
      return this.publicRequest(raced);
    }
  }

  async confirm(id: string, userId: string, accessToken: string, dynamicCode: string) {
    const request = await this.requests.findOne({ where: { id, userId } });
    if (!request) throw new NotFoundException('Solicitud de transferencia no encontrada.');
    if (request.status === 'completed') return this.publicRequest(request);
    if (request.status === 'cancelled') {
      throw new ConflictException('La solicitud fue cancelada.');
    }

    // Como en los bancos: sin clave dinámica válida no se mueve dinero.
    await this.verifyDynamicKey(userId, dynamicCode);

    // Reclama la solicitud de forma atómica: pendiente, o 'processing' abandonada.
    const claim = await this.requests
      .createQueryBuilder()
      .update(TransferRequest)
      .set({ status: 'processing' })
      .where('id = :id AND user_id = :userId', { id, userId })
      .andWhere(
        "(status = 'pending' OR (status = 'processing' AND updated_at < :stale))",
        { stale: new Date(Date.now() - STALE_PROCESSING_MS) },
      )
      .execute();
    if (claim.affected !== 1) {
      const latest = await this.requests.findOne({ where: { id, userId } });
      if (latest?.status === 'completed') return this.publicRequest(latest);
      throw new ConflictException('La solicitud ya está siendo procesada.');
    }

    try {
      const transaction = await this.postToLedger(request, accessToken);
      request.status = 'completed';
      request.ledgerTransactionId = transaction.id ?? null;
      await this.requests.save(request);
      return this.publicRequest(request);
    } catch (error) {
      await this.requests.update({ id, userId, status: 'processing' }, { status: 'pending' });
      throw error;
    }
  }

  async list(userId: string) {
    const requests = await this.requests.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: 50,
    });
    return requests.map((request) => this.publicRequest(request));
  }

  async cancel(id: string, userId: string) {
    const request = await this.requests.findOne({ where: { id, userId } });
    if (!request) throw new NotFoundException('Solicitud de transferencia no encontrada.');
    if (request.status === 'cancelled') return this.publicRequest(request);
    if (request.status !== 'pending') {
      throw new ConflictException('Solo se pueden cancelar solicitudes pendientes.');
    }
    const result = await this.requests.update({ id, userId, status: 'pending' }, { status: 'cancelled' });
    if (result.affected !== 1) throw new ConflictException('La solicitud ya está siendo procesada.');
    request.status = 'cancelled';
    return this.publicRequest(request);
  }

  /** Valida la clave dinámica con Auth Service (red interna, INTERNAL_API_KEY). */
  private async verifyDynamicKey(userId: string, code: string): Promise<void> {
    const baseUrl = this.config.get<string>('AUTH_SERVICE_URL', 'http://localhost:3001');
    const key = this.config.get<string>('INTERNAL_API_KEY');
    if (!key) throw new ServiceUnavailableException('INTERNAL_API_KEY no está configurada en Transfer Service.');

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/internal/dynamic-key/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-key': key },
        body: JSON.stringify({ idUser: userId, code }),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new ServiceUnavailableException('No se pudo validar la clave dinámica. Inténtalo de nuevo.');
    }

    const payload = await response.json().catch(() => ({}));
    if (response.status === 403 && /clave dinámica/i.test(payload?.message || '')) {
      throw new ForbiddenException(payload.message);
    }
    if (!response.ok) throw new ServiceUnavailableException('No se pudo validar la clave dinámica. Inténtalo de nuevo.');
    if (payload?.valid !== true) {
      throw new BadRequestException(payload?.message || 'Clave dinámica incorrecta o vencida.');
    }
  }

  /** Valida los datos de un envío a otro banco o billetera. */
  private externalDestination(dto: PrepareTransferDto) {
    const bank = dto.destinationBank;
    const isWallet = WALLETS.includes(bank);
    const number = String(dto.destinationAccountNumber ?? '');
    if (isWallet && !/^3\d{9}$/.test(number)) {
      throw new BadRequestException(`El número de ${bank} es un celular de 10 dígitos que empieza por 3.`);
    }
    if (!isWallet && !/^\d{6,16}$/.test(number)) {
      throw new BadRequestException('El número de cuenta debe tener entre 6 y 16 dígitos.');
    }
    if (!isWallet && !dto.destinationAccountType) throw new BadRequestException('Elige el tipo de cuenta.');
    if (!dto.recipientName || dto.recipientName.trim().length < 3) {
      throw new BadRequestException('Escribe el nombre de quien recibe.');
    }
    return {
      destinationBank: bank,
      destinationAccountType: isWallet ? null : dto.destinationAccountType,
      externalAccountNumber: number,
    };
  }

  /** La cuenta de origen es del usuario y está activa (account-service, red interna). */
  private async assertOwnAccount(accountId: string, userId: string) {
    const baseUrl = this.config.get<string>('ACCOUNT_SERVICE_URL', 'http://localhost:3002');
    const key = this.config.get<string>('INTERNAL_API_KEY');
    if (!key) throw new ServiceUnavailableException('INTERNAL_API_KEY no está configurada en Transfer Service.');
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/internal/accounts/${encodeURIComponent(accountId)}/ledger-info`, {
        headers: { 'x-internal-key': key },
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new ServiceUnavailableException('No se pudo validar tu cuenta. Inténtalo de nuevo.');
    }
    if (response.status === 404) throw new NotFoundException('Cuenta de origen no encontrada.');
    if (!response.ok) throw new ServiceUnavailableException('No se pudo validar tu cuenta. Inténtalo de nuevo.');
    const account = await response.json();
    if (account.idUser !== userId || account.accountType === 'merchant') {
      throw new ForbiddenException('La cuenta de origen no te pertenece.');
    }
    if (account.status !== 'active') throw new BadRequestException('Tu cuenta no está activa, por eso no puedes transferir.');
  }

  private async postToLedger(request: TransferRequest, accessToken: string): Promise<{ id?: string }> {
    const baseUrl = this.config.get<string>('LEDGER_SERVICE_URL', 'http://localhost:3006');
    let response: Response;
    try {
      // Otro banco: cargo hacia la cuenta de compensación (ledger, red interna);
      // entre cuentas Banklite: transferencia con el token del cliente.
      const external = !!request.destinationBank;
      response = await fetch(`${baseUrl}${external ? '/ledger/internal/debits' : '/ledger/transfers'}`, {
        method: 'POST',
        headers: external
          ? { 'x-internal-key': this.config.get<string>('INTERNAL_API_KEY') ?? '', 'Content-Type': 'application/json' }
          : { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(external
          ? {
              accountId: request.sourceAccountId,
              amount: Number(request.amount),
              description: this.externalDescription(request),
              idempotencyKey: request.idempotencyKey,
            }
          : {
              sourceAccountId: request.sourceAccountId,
              destinationAccountNumber: request.destinationAccountNumber,
              amount: Number(request.amount),
              description: request.description,
              idempotencyKey: request.idempotencyKey,
            }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new ServiceUnavailableException('No se pudo contactar Ledger Service. Puedes reintentar la confirmación.');
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = Array.isArray(payload?.message)
        ? payload.message.join(', ')
        : payload?.message || 'Ledger Service rechazó la transferencia.';
      if (response.status >= 500) throw new BadGatewayException(message);
      throw new HttpException(message, response.status);
    }
    return payload;
  }

  /** Cuenta destino de una llave Bre-B (account-service, red interna). */
  private async resolveKey(rawKey: string): Promise<{ accountNumber: string; key: string; holderName: string }> {
    const baseUrl = this.config.get<string>('ACCOUNT_SERVICE_URL', 'http://localhost:3002');
    const key = this.config.get<string>('INTERNAL_API_KEY');
    if (!key) throw new ServiceUnavailableException('INTERNAL_API_KEY no está configurada en Transfer Service.');
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/internal/accounts/keys/resolve?key=${encodeURIComponent(rawKey)}`, {
        headers: { 'x-internal-key': key },
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new ServiceUnavailableException('No se pudo consultar la llave Bre-B. Inténtalo de nuevo.');
    }
    const payload = await response.json().catch(() => ({}));
    if (response.status === 404 || response.status === 400) {
      throw new HttpException(payload?.message || 'No encontramos esa llave en Banklite.', response.status);
    }
    if (!response.ok) throw new ServiceUnavailableException('No se pudo consultar la llave Bre-B. Inténtalo de nuevo.');
    return { accountNumber: payload.accountNumber, key: payload.key, holderName: payload.holderName };
  }

  // Descripción en el movimiento: así se reconoce en el historial como transferencia a otro banco.
  private externalDescription(request: TransferRequest): string {
    const account = `${request.destinationAccountType ? request.destinationAccountType + ' ' : ''}···· ${request.externalAccountNumber.slice(-4)}`;
    const concept = request.description && request.description !== 'Transferencia' ? ` · ${request.description}` : '';
    return `Transferencia a ${request.destinationBank} · ${account} · ${request.recipientName}${concept}`.slice(0, 140);
  }

  private assertSameRequest(request: TransferRequest, dto: PrepareTransferDto, userId: string) {
    const sameDestination = dto.destinationBank
      ? request.destinationBank === dto.destinationBank && request.externalAccountNumber === dto.destinationAccountNumber
      : dto.destinationKey
        ? request.destinationKey === normalizeKey(dto.destinationKey)
        : request.destinationAccountNumber === dto.destinationAccountNumber;
    if (
      request.userId !== userId ||
      request.sourceAccountId !== dto.sourceAccountId ||
      !sameDestination ||
      Number(request.amount) !== Number(dto.amount)
    ) {
      throw new ConflictException('La clave de idempotencia ya se usó para otra solicitud.');
    }
  }

  private publicRequest(request: TransferRequest) {
    return {
      id: request.id,
      sourceAccountId: request.sourceAccountId,
      // Con llave, quien envía no ve el número de cuenta de quien recibe.
      destinationAccountNumber: request.destinationKey || request.destinationBank ? null : request.destinationAccountNumber,
      destinationAccountLast4: (request.externalAccountNumber || request.destinationAccountNumber).slice(-4),
      destinationBank: request.destinationBank,
      destinationAccountType: request.destinationAccountType,
      destinationKey: request.destinationKey,
      recipientName: request.recipientName,
      amount: Number(request.amount),
      description: request.description,
      status: request.status,
      ledgerTransactionId: request.ledgerTransactionId,
      createdAt: request.createdAt,
    };
  }
}