import {
  BadRequestException,
  ForbiddenException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { currentBankName, WALLETS } from './banks';
import { PrepareTransferDto } from './dto/prepare-transfer.dto';
import { TransferRequest } from './entities/transfer-request.entity';
import { TransferClientsService } from './transfer-clients.service';

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
    private readonly clients: TransferClientsService,
  ) {}

  async prepare(dto: PrepareTransferDto, userId: string) {
    // Un frontend viejo puede mandar el nombre antiguo de la entidad: se guarda el vigente.
    if (dto.destinationBank) dto.destinationBank = currentBankName(dto.destinationBank) ?? undefined;
    const existing = await this.requests.findOne({ where: { idempotencyKey: dto.idempotencyKey } });
    if (existing) {
      this.assertSameRequest(existing, dto, userId);
      return this.publicRequest(existing);
    }

    let destination: { accountNumber: string; key: string | null; holderName: string | null };
    let external: Pick<TransferRequest, 'destinationBank' | 'destinationAccountType' | 'externalAccountNumber'> = {
      destinationBank: null,
      destinationAccountType: null,
      externalAccountNumber: null,
    };
    if (dto.destinationBank) {
      // Otro banco o billetera: el dinero sale por la cuenta de compensación del
      // ledger, que no valida al titular; por eso se valida aquí que la cuenta sea suya.
      external = this.externalDestination(dto);
      await this.assertOwnAccount(dto.sourceAccountId, userId);
      destination = { accountNumber: '', key: null, holderName: dto.recipientName.trim() };
    } else if (dto.destinationKey) {
      // Con llave, account-service dice a qué cuenta llega (por la red interna).
      destination = await this.clients.resolveKey(dto.destinationKey);
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
    await this.clients.verifyDynamicKey(userId, dynamicCode);

    // Reclama la solicitud de forma atómica: pendiente, o 'processing' abandonada.
    const claim = await this.requests
      .createQueryBuilder()
      .update(TransferRequest)
      .set({ status: 'processing' })
      .where('id = :id AND user_id = :userId', { id, userId })
      .andWhere("(status = 'pending' OR (status = 'processing' AND updated_at < :stale))", {
        stale: new Date(Date.now() - STALE_PROCESSING_MS),
      })
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
    const account = await this.clients.sourceAccount(accountId);
    if (account.idUser !== userId || account.accountType === 'merchant') {
      throw new ForbiddenException('La cuenta de origen no te pertenece.');
    }
    if (account.status !== 'active')
      throw new BadRequestException('Tu cuenta no está activa, por eso no puedes transferir.');
  }

  // Otro banco: cargo hacia la cuenta de compensación; entre cuentas Banklite:
  // transferencia con el token del cliente. Ambos idempotentes por idempotencyKey.
  private postToLedger(request: TransferRequest, accessToken: string): Promise<{ id?: string }> {
    if (request.destinationBank) {
      return this.clients.debitToClearing({
        accountId: request.sourceAccountId,
        amount: Number(request.amount),
        description: this.externalDescription(request),
        idempotencyKey: request.idempotencyKey,
      });
    }
    return this.clients.transfer(
      {
        sourceAccountId: request.sourceAccountId,
        destinationAccountNumber: request.destinationAccountNumber,
        amount: Number(request.amount),
        description: request.description,
        idempotencyKey: request.idempotencyKey,
      },
      accessToken,
    );
  }

  // Descripción en el movimiento: así se reconoce en el historial como transferencia a otro banco.
  private externalDescription(request: TransferRequest): string {
    const account = `${request.destinationAccountType ? request.destinationAccountType + ' ' : ''}···· ${request.externalAccountNumber.slice(-4)}`;
    const concept = request.description && request.description !== 'Transferencia' ? ` · ${request.description}` : '';
    return `Transferencia a ${request.destinationBank} · ${account} · ${request.recipientName}${concept}`.slice(0, 140);
  }

  private assertSameRequest(request: TransferRequest, dto: PrepareTransferDto, userId: string) {
    const sameDestination = dto.destinationBank
      ? currentBankName(request.destinationBank) === dto.destinationBank &&
        request.externalAccountNumber === dto.destinationAccountNumber
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
      destinationAccountNumber:
        request.destinationKey || request.destinationBank ? null : request.destinationAccountNumber,
      destinationAccountLast4: (request.externalAccountNumber || request.destinationAccountNumber).slice(-4),
      // Las solicitudes viejas guardan el nombre antiguo (marca real): se muestra el vigente.
      destinationBank: currentBankName(request.destinationBank),
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
