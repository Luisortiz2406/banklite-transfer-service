import {
  BadGatewayException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PrepareTransferDto } from './dto/prepare-transfer.dto';
import { TransferRequest } from './entities/transfer-request.entity';

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

    const request = this.requests.create({
      userId,
      sourceAccountId: dto.sourceAccountId,
      destinationAccountNumber: dto.destinationAccountNumber,
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

  async confirm(id: string, userId: string, accessToken: string) {
    const request = await this.requests.findOne({ where: { id, userId } });
    if (!request) throw new NotFoundException('Solicitud de transferencia no encontrada.');
    if (request.status === 'completed') return this.publicRequest(request);
    if (request.status === 'processing') {
      throw new ConflictException('La transferencia ya está siendo procesada.');
    }

    const claim = await this.requests.update(
      { id, userId, status: 'pending' },
      { status: 'processing' },
    );
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

  private async postToLedger(request: TransferRequest, accessToken: string): Promise<{ id?: string }> {
    const baseUrl = this.config.get<string>('LEDGER_SERVICE_URL', 'http://localhost:3006');
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/ledger/transfers`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
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

  private assertSameRequest(request: TransferRequest, dto: PrepareTransferDto, userId: string) {
    if (
      request.userId !== userId ||
      request.sourceAccountId !== dto.sourceAccountId ||
      request.destinationAccountNumber !== dto.destinationAccountNumber ||
      Number(request.amount) !== Number(dto.amount)
    ) {
      throw new ConflictException('La clave de idempotencia ya se usó para otra solicitud.');
    }
  }

  private publicRequest(request: TransferRequest) {
    return {
      id: request.id,
      sourceAccountId: request.sourceAccountId,
      destinationAccountNumber: request.destinationAccountNumber,
      amount: Number(request.amount),
      description: request.description,
      status: request.status,
      ledgerTransactionId: request.ledgerTransactionId,
      createdAt: request.createdAt,
    };
  }
}