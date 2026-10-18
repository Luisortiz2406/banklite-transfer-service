-- Datos de ejemplo de transfer_db (transfer-service). Escenario de demo compartido por todos
-- los microservicios (mismos UUID): Ana Pérez y Carlos Gómez, clientes de prueba,
-- y una cuenta de comercio. Datos inventados: no son personas ni documentos reales.
-- Cargar después del esquema:  psql "$DATABASE_URL" -f database/schema.sql -f database/seed.sql
-- (si la base ya tiene estas filas, ON CONFLICT DO NOTHING las deja como están)

BEGIN;

INSERT INTO public.transfer_requests (id, user_id, source_account_id, destination_account_number, amount, description, idempotency_key, status, ledger_transaction_id, created_at, updated_at) VALUES
  ('3d000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', '3a000000-0000-4000-8000-000000000001', '10000000002', 150000, 'Arriendo compartido', '7c000000-0000-4000-8000-000000000002', 'completed', '7b000000-0000-4000-8000-000000000002', '2026-10-02 10:00:00-05', '2026-10-02 10:00:00-05')
ON CONFLICT DO NOTHING;

COMMIT;
