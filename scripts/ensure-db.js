// Crea la base de datos de DATABASE_URL si aún no existe (equivale a los
// contenedores *-db-init de docker-compose). Se ejecuta antes de arrancar.
const { Client } = require('pg');

async function main() {
  const url = new URL(process.env.DATABASE_URL);
  const dbName = decodeURIComponent(url.pathname.slice(1));
  if (!dbName || dbName === 'postgres') return;

  url.pathname = '/postgres';
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (rowCount === 0) {
      await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
      console.log(`[ensure-db] Base de datos ${dbName} creada`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[ensure-db] No se pudo verificar/crear la base de datos:', err.message);
  process.exit(1);
});
