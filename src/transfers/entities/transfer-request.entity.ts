import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('transfer_requests')
@Index('idx_transfer_requests_user_created', ['userId', 'createdAt'])
export class TransferRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'source_account_id', type: 'uuid' })
  sourceAccountId: string;

  @Column({ name: 'destination_account_number', type: 'varchar', length: 11 })
  destinationAccountNumber: string;

  // Envío con llave Bre-B: la llave y el nombre enmascarado del titular. En ese
  // caso el número de cuenta destino nunca se le muestra a quien envía.
  @Column({ name: 'destination_key', type: 'varchar', length: 120, nullable: true })
  destinationKey: string | null;

  @Column({ name: 'recipient_name', type: 'varchar', length: 80, nullable: true })
  recipientName: string | null;

  // Envío a otro banco o billetera (destino de demostración: no hay conexión con
  // la red interbancaria). Aquí destination_account_number queda vacío.
  @Column({ name: 'destination_bank', type: 'varchar', length: 40, nullable: true })
  destinationBank: string | null;

  @Column({ name: 'destination_account_type', type: 'varchar', length: 10, nullable: true })
  destinationAccountType: string | null;

  @Column({ name: 'external_account_number', type: 'varchar', length: 16, nullable: true })
  externalAccountNumber: string | null;

  @Column({ type: 'numeric', precision: 18, scale: 2 })
  amount: string;

  @Column({ type: 'varchar', length: 140, default: 'Transferencia' })
  description: string;

  @Index({ unique: true })
  @Column({ name: 'idempotency_key', type: 'uuid' })
  idempotencyKey: string;

  @Column({ type: 'varchar', default: 'pending' })
  status: 'pending' | 'processing' | 'completed' | 'cancelled';

  @Column({ name: 'ledger_transaction_id', type: 'uuid', nullable: true })
  ledgerTransactionId: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
