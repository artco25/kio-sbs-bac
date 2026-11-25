# KIO SBS — Backend (Cloudflare Workers + D1 + GraphQL)

Versión reducida de KIO (módulos `artix_*` de Odoo) para la edición **KIO SBS** (*Small Business Solution*),
con los 4 ejes: **Comercial · Punto de venta · Financiero · Personal y nómina**.

Dos Workers **Express 5 + GraphQL** comparten la misma base **D1 `kio-sbs`**:

| Worker | Config | Endpoint | Para qué |
|---|---|---|---|
| `kio-sbs-api` | `wrangler.api.jsonc` | `POST /graphql`, `POST /provision` | Login, usuarios/roles, empresa, aprobaciones y consultas ricas (cartera, panel KIO, nómina, inventario…) |
| `kio-sbs-sync` | `wrangler.sync.jsonc` | `POST /graphql` (`pull`, `push`, `status`) + cron diario | Sincronización offline-first de las apps Flutter cada 90 s |

Express corre dentro del Worker con `httpServerHandler` de `cloudflare:node` (`nodejs_compat`).

```
schema/tables.json        ← fuente única de las 14 tablas sincronizables, roles y permisos
scripts/gen-schema.mjs    → migrations/0006_sbs_v2.sql  +  app Flutter lib/data/tables.g.dart
src/shared/               auth (PBKDF2, tokens hash), sync (LWW + revisiones), http (Express+GraphQL, límites)
src/api/                  esquema y resolvers GraphQL, /provision
src/sync/                 pull / push / status + cron
legacy/                   worker REST del prototipo anterior (sólo referencia, se puede borrar)
```

## Modelo de sincronización

* IDs **UUID generados en el cliente** → se crean registros sin internet.
* Cada fila lleva `updated_at` (ISO UTC con ms), `deleted` (borrado lógico) y `rev`.
* `push` (≤ 40 cambios): el servidor reserva N revisiones en `sync_counter` y hace upsert en un
  `DB.batch` atómico. Gana el `updated_at` más reciente (LWW) **y** las reglas del rol; el `rev` siempre
  avanza, así el equipo que perdió recibe la versión ganadora en su siguiente `pull`.
* `pull(since)`: filas con `rev` en `(since, since+limit]` de las tablas que el rol puede leer.
* Reglas en servidor: `company_id` nunca viene del cliente; columnas en lista blanca (sólo las enviadas);
  cajero/vendedor no modifican ventas confirmadas, pagos, movimientos ni cajas cerradas; cupo y bloqueo de
  cartera sólo admin/contador; aprobación de gastos/permisos sólo admin/contador; montos no negativos.

## Desarrollo local

```bash
npm install
cp .dev.vars.example .dev.vars          # PROVISION_TOKEN local (≥ 24 caracteres)
npm run db:migrate                      # D1 local
npm run dev:api                         # http://127.0.0.1:8797  (otra terminal)
npm run dev:sync                        # http://127.0.0.1:8798
npm run seed:dev                        # empresa Artix + admin@artix.co (clave en .dev.vars → DEV_ADMIN_PASSWORD)
npm run password:dev                    # cambiar la clave de un usuario local
npm run smoke                           # 17 verificaciones de punta a punta (auth, roles, sync, cartera, límites)
node scripts/check-roles.mjs            # auto-registro, roles personalizados y acceso por suite
node scripts/check-web-api.mjs          # operaciones que usa el admin web (saveRecords, deleteRecord…)
node scripts/demo-data.mjs              # ~3 meses de ventas, gastos y personal de ejemplo
```

No existen usuarios por defecto: toda empresa se crea con `/provision` (protegido con `PROVISION_TOKEN`).

## Despliegue a Cloudflare

```bash
npx wrangler login
# 1. Respaldo previo (0006 elimina las tablas del prototipo 0001-0005)
npx wrangler d1 export kio-sbs --remote --output respaldo-antes-v2.sql
# 2. Secreto de aprovisionamiento (sólo en el worker api)
npx wrangler secret put PROVISION_TOKEN -c wrangler.api.jsonc
# 3. Typecheck + migraciones remotas + deploy de los 2 workers
npm run deploy
# 4. Crear la primera empresa
curl -X POST https://kio-sbs-api.<tu-cuenta>.workers.dev/provision \
  -H "X-Provision-Token: <token>" -H "Content-Type: application/json" \
  -d '{"company":{"name":"Mi empresa","nit":"900..."},"admin":{"name":"Admin","email":"admin@miempresa.co","password":"<clave segura>"},"demo":false}'
```

* `CORS_ORIGIN` (en los `vars` de cada config) admite una lista separada por comas; las apps de escritorio no lo necesitan.
* Si la cuenta es del plan Free, D1 permite 50 consultas por invocación: por eso `push` acepta máximo 40 cambios.
* D1 Time Travel permite restaurar la base a un punto anterior si algo sale mal.

## Suites, roles y auto-registro

* **Suites** (`src/shared/suites.ts`): Comercial · Punto de venta · Financiero · Personal y nómina · Sistema. El usuario
  ingresa por suite y sólo ve los módulos de las suites que su rol permite.
* **Roles base**: `admin`, `contador`, `cajero`, `vendedor` (permisos en `schema/tables.json`).
* **Roles personalizados por empresa** (`saveRole`, tabla `roles`): cada empresa define qué suites habilita y,
  por módulo, `r` (consultar) o `w` (editar). El rol base del rol personalizado define aprobaciones y bloqueos
  (cajero/vendedor no modifican documentos confirmados). Los permisos se aplican en la API **y** en el sync
  (el equipo de un cajero sólo descarga las tablas que su rol puede leer).
* **Auto-registro**: mutación `signup` crea empresa + administrador y devuelve sesión. Se activa con la variable
  `ALLOW_SIGNUP` (`wrangler.api.jsonc`; con otro valor queda cerrado y sólo se crean empresas con `/provision`).
  Tiene límite de intentos por IP.

## Ejemplos GraphQL

```graphql
mutation { login(email: "admin@artix.co", password: "…") { token me { user { name role } company { name } } } }

{ dashboard { kpis { key label value previous } aging { bucket amount } months { month sales expenses } } }

{ partners(withBalance: true) { total items { name balance overdue availableCredit sales(limit: 5) { number total balance } } } }

{ receivables(overdueOnly: true) { number dueDate total balance partner { name phone } } }
```

## Pendiente / conocido

* Parámetros de nómina 2026: SMMLV y auxilio según Decreto 1470 de 2025; **verificar la UVT 2026** con la resolución DIAN.
* La liquidación de nómina es simplificada; no genera nómina electrónica DIAN ni factura electrónica.
* No hay bitácora de versiones anteriores (auditoría) ni rate limit por usuario en `push`.
