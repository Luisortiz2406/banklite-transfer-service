# Transfer Service (`transfer-service`)

[![Despliegue](https://github.com/Luisortiz2406/banklite-transfer-service/actions/workflows/deploy.yml/badge.svg?branch=main)](https://github.com/Luisortiz2406/banklite-transfer-service/actions/workflows/deploy.yml)

Transferencias del cliente: a cuentas BankLite, con llave Banklite y a otros bancos (simulado, con entidades de nombre ficticio: ver `src/transfers/banks.ts`).

Parte de **BankLite**, banco digital académico construido con microservicios. Cada
microservicio tiene su propia base de datos y se comunica con los demás por HTTP
(red interna) o por eventos en RabbitMQ.

## Responsabilidad dentro de la arquitectura

Orquesta el envío de dinero que inicia el cliente en dos pasos: **preparar** (valida
destino, monto y dueño de la cuenta origen) y **confirmar** con la clave dinámica, que
es cuando se registra en ledger-service. Guarda cada solicitud con su estado para
que reintentar la confirmación no cobre dos veces.

**Reglas de negocio principales**

- Monto mínimo por envío publicado en `GET /transfers/catalog` (hoy $1.000); aplica solo a las transferencias del cliente.
- La cuenta origen debe ser del usuario; destino distinto del origen.
- Confirmación con clave dinámica (auth-service); la `idempotencyKey` se reenvía al ledger y evita cobros dobles.
- Estados `pending`, `processing`, `completed` y `cancelled`; si el ledger no responde, la confirmación se reintenta con la misma clave sin cobrar dos veces.
- Envíos a otros bancos: no hay red interbancaria real; se dice en la interfaz.

**Comunicación con otros servicios**

| | |
|---|---|
| Publica eventos | — |
| Consume eventos | — |
| Llama a | account-service: cuenta origen, destino por número o llave Banklite<br>auth-service: clave dinámica<br>ledger-service: `POST /ledger/transfers` |
| Lo llaman | api-gateway (rutas `/transfers/*`) |
| Integraciones externas | — |

Todo el tráfico externo entra por el **api-gateway** (único servicio público), que
enruta por prefijo (`/transfers`), aplica CORS y límite de peticiones, y bloquea las
rutas internas.

## Tecnologías

- Node.js 20, NestJS 10 y TypeScript
- PostgreSQL con TypeORM (`synchronize: true`: las tablas se crean desde las entidades)
- JWT (`@nestjs/jwt`) y `class-validator` para validar todo lo que entra
- Docker (imagen `node:20-alpine`) y despliegue en Railway

## Base de datos (`transfer_db`)

| Tabla | Contenido |
|---|---|
| `transfer_requests` | Solicitudes de transferencia, estado y transacción del ledger. |

En `database/`:

| Archivo | Qué es |
|---|---|
| `schema.sql` | Esquema (tablas, índices, restricciones), generado con `pg_dump --schema-only` desde la base que crea TypeORM. |
| `seed.sql` | Datos de ejemplo de un escenario de demo compartido por todos los servicios (clientes ficticios Ana y Carlos, con los mismos UUID en todas las bases). |
| `backup.sql` | Respaldo completo (esquema + datos de ejemplo) listo para restaurar. |

Restaurar en una base vacía:

```bash
createdb transfer_db
psql "postgres://usuario:clave@localhost:5432/transfer_db" -f database/backup.sql
# o, por partes:
psql "$DATABASE_URL" -f database/schema.sql -f database/seed.sql
```

Si se arranca el servicio con una base vacía, TypeORM crea las tablas solo.

## Instalación y ejecución

Requisitos: Node.js 20, PostgreSQL 16.

```bash
npm ci
cp .env.example .env     # completa los secretos (ver abajo)
npm run start:dev        # desarrollo, recarga al guardar
# producción:
npm run build && npm run start:prod
```

Con Docker:

```bash
docker build -t banklite-transfer-service .
docker run --env-file .env -p 3008:3008 banklite-transfer-service
```

El sistema completo (los 12 servicios, Postgres, RabbitMQ y el gateway) se levanta
desde el repositorio principal con `docker compose up -d --build`.

Comprobar: `curl http://localhost:3008/health`

## Endpoints principales

A través del gateway las rutas son las mismas (`http://localhost:8080/transfers/...`).

### Públicos (sin sesión)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Estado del servicio y de su base (`SELECT 1`); responde 503 con `status: down` si la base no contesta. |
| GET | `/transfers/catalog` | Monto mínimo por envío. |

### Del cliente (`Authorization: Bearer <token de acceso>`)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/transfers` | Transferencias del cliente. |
| POST | `/transfers/prepare` | Prepara una transferencia (valida destino y monto). |
| POST | `/transfers/:id/confirm` | Confirma con la clave dinámica y la registra en el ledger. |
| POST | `/transfers/:id/cancel` | Cancela una transferencia pendiente. |

## Variables de entorno

Ver `.env.example`. Los secretos se generan con
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` (uno distinto
por variable). El servicio **no arranca** si un secreto falta, es corto, es un valor de
ejemplo o se repite entre dos variables (`src/config/env.validation.ts`). En Railway
todas se configuran como variables del servicio, nunca en el código.

| Variable | Obligatoria | Ejemplo / por defecto | Para qué sirve |
|---|---|---|---|
| `NODE_ENV` | No | `development` | `development` en local; `production` en Railway (lo fija el Dockerfile). |
| `PORT` | No | `3008` | Puerto HTTP del servicio. |
| `DATABASE_URL` | **Sí** (no arranca sin ella) | `postgres://transfer_svc:<DB_PASSWORD_TRANSFER>@localhost:5432/transfer_db` | Conexión a PostgreSQL de **su** base (rol propio, sin acceso a las demás). |
| `JWT_SECRET` | **Sí** (no arranca sin ella) | — | Firma de los JWT de clientes (el mismo valor que en auth-service). |
| `LEDGER_SERVICE_URL` | Sí | `http://localhost:3006` | URL interna de ledger-service. |
| `AUTH_SERVICE_URL` | Sí | `http://localhost:3001` | URL interna de auth-service. |
| `ACCOUNT_SERVICE_URL` | Sí | `http://localhost:3002` | URL interna de account-service. |
| `INTERNAL_API_KEY` | **Sí** (no arranca sin ella) | — | Clave interna **propia** de este servicio; la manda en `x-internal-key` al llamar a otros. |
| `HTTP_READ_RETRIES` | No | `1` | Reintentos de las lecturas (GET) a otros servicios; las escrituras no se reintentan. |

## Pruebas

```bash
npm test
```

Pruebas unitarias con Jest, sin base de datos: `TransfersService` con un repositorio en
memoria y las llamadas a auth, account y ledger simuladas.

- **Preparar**: entre cuentas Banklite (11 dígitos), con llave Banklite (no muestra el
  número de quien recibe) y a otro banco o billetera (celular de billetera, tipo de
  cuenta, nombre, cuenta de origen propia, activa y que no sea de comercio).
- **Idempotencia**: la misma clave con los mismos datos devuelve la misma solicitud;
  con otros datos u otro usuario da 409; la carrera al guardar devuelve la ganadora.
- **Confirmar**: sin clave dinámica válida no se reclama ni se llama al ledger; si el
  ledger falla vuelve a pendiente y el reintento usa la misma clave; una completada no
  mueve dinero otra vez; procesando, cancelada u otro cliente no confirman; a otro banco
  el cargo va a compensación con solo los últimos 4 dígitos en la descripción.
- **Nombres anteriores de las entidades**: un nombre antiguo se guarda y se muestra con el
  vigente, se cobra con el vigente y no rompe la idempotencia de la misma clave.
- **Cancelar y listar**: solo pendientes; cada cliente ve solo las suyas.
- **Validación del DTO**: monto mínimo de $1.000 y 2 decimales, UUID, cuenta o llave,
  solo dígitos, entidades y tipos de cuenta de la lista.
- **Llamadas a otros servicios** (`transfer-clients.service.spec.ts`, con `fetch` simulado): un rechazo
  de negocio del ledger (saldo insuficiente, límite diario) llega al cliente con su estado y
  mensaje; si el ledger, auth o account fallan o rechazan la clave interna es 503; la clave
  dinámica incorrecta es 400; las escrituras no se reintentan solas.
- **Controladores, guard de sesión, `/health` y validación de la configuración.**

**Cobertura:** el pipeline la muestra en el resumen de cada corrida y exige un mínimo de
70 % de líneas y 50 % de ramas (`umbral-lineas` y `umbral-ramas` en `deploy.yml`). Hoy
está en 92,9 % de líneas y 89,7 % de ramas.

Las reglas de negocio también se prueban de punta a punta con los scripts de
`scripts/pruebas/` del repositorio principal.

## Despliegue

Lo despliega **GitHub Actions** (`.github/workflows/deploy.yml`, que usa el workflow
reutilizable de [banklite-pipelines](https://github.com/Luisortiz2406/banklite-pipelines)):

1. **test**: lint, formato, build y pruebas (también en cada pull request).
2. **docker** (solo `main`): imagen en GHCR `ghcr.io/luisortiz2406/banklite-transfer-service`,
   etiquetada con el SHA del commit y `latest` (se guardan las últimas 5).
3. **deploy** (solo `main`): `railway up --ci` sube el commit a Railway, que lo
   construye con el `Dockerfile` y aplica `railway.json` (health check en `/health`);
   el job espera a que el despliegue quede activo.

El repositorio está desconectado del autodeploy de Railway: un push a `main` despliega
solo a través de este pipeline, y únicamente si las pruebas pasan. Rollback: panel de
Railway → *Deployments* → versión anterior → *Rollback*. El servicio no tiene dominio público propio: se accede
por el gateway.

- Estado del servicio y de su base: [https://api-gateway-production-dd7f.up.railway.app/health](https://api-gateway-production-dd7f.up.railway.app/health) (entrada `transfer-service`: `status` y `database` deben estar en `ok`)
- Endpoint público de prueba: https://api-gateway-production-dd7f.up.railway.app/transfers/catalog
- Rutas de este servicio: `https://api-gateway-production-dd7f.up.railway.app/transfers/...`
- Aplicación web: https://frontend-production-eff3c.up.railway.app

## Repositorios relacionados

Servicios de BankLite con los que se comunica este. **Llama a** / **Lo llama**: HTTP
por la red interna; **Recibe** / **Envía**: eventos en RabbitMQ. Cada uno vive y se
despliega desde su propio repositorio.

| Repositorio | Relación con este servicio |
|---|---|
| [banklite-api-gateway](https://github.com/Luisortiz2406/banklite-api-gateway) | **Lo llama:** punto de entrada público, le enruta las rutas de este servicio |
| [banklite-account-service](https://github.com/Luisortiz2406/banklite-account-service) | **Llama a:** cuentas origen y destino, resolución de llaves Banklite |
| [banklite-auth-service](https://github.com/Luisortiz2406/banklite-auth-service) | **Llama a:** verificación de la clave dinámica |
| [banklite-ledger-service](https://github.com/Luisortiz2406/banklite-ledger-service) | **Llama a:** registrar la transferencia (`POST /ledger/transfers`) |
