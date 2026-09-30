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