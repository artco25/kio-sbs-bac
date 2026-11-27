// Sync GraphQL schema - compartido por worker sync standalone y API unificada.
import { buildSchema } from "graphql";
import { gqlError, requireUser } from "../shared/auth";
import { nowIso } from "../shared/crypto";
import { env } from "../shared/env";
import { addResolvers, type Ctx } from "../shared/http";
import {
  MAX_PUSH,
  TABLE_NAMES,
  canRead,
  headRev,
  prepareChange,
  pullChanges,
  writeRowsTolerant,
  type PreparedRow,
  type Rejection,
} from "../shared/sync";

const typeDefs = /* GraphQL */ `
  scalar JSON

  type TableChanges {
    table: String!
    rows: [JSON!]!
  }
  type PullResult {
    "Revisión hasta la que llegan estos cambios; enviarla como 'since' en el siguiente pull"
    cursor: Int!
    head: Int!
    hasMore: Boolean!
    "true si el cursor del cliente es mayor que el del servidor (BD restaurada): reiniciar desde 0"
    reset: Boolean!
    serverTime: String!
    changes: [TableChanges!]!
  }
  type Rejection {
    table: String!
    id: String
    reason: String!
  }
  type PushResult {
    accepted: Int!
    rejected: [Rejection!]!
    head: Int!
    serverTime: String!
  }
  type SyncStatus {
    head: Int!
    serverTime: String!
    role: String!
    maxPush: Int!
    tables: [String!]!
  }

  input ChangeInput {
    table: String!
    row: JSON!
  }
  input DeviceInput {
    id: String!
    name: String
    platform: String
    appVersion: String
    pending: Int
    cursor: Int
    terminalCode: String
    section: String
    macAddress: String
    hardwareId: String
  }

  type Query {
    status: SyncStatus!
    pull(since: Int!, limit: Int, device: DeviceInput): PullResult!
  }
  type Mutation {
    push(changes: [ChangeInput!]!): PushResult!
  }
`;

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Límite de equipos de la licencia: un equipo nuevo no se registra si ya se alcanzó el tope (cuentan los vistos en 30 días). */
async function assertDeviceAllowed(u: NonNullable<Ctx["user"]>, d: Record<string, unknown> | undefined) {
  const max = u.license?.max_devices;
  if (max == null || u.platform_role || !d || typeof d.id !== "string") return;
  const known = await env.DB.prepare("SELECT 1 AS x FROM devices WHERE id = ? AND company_id = ?").bind(d.id, u.company_id).first();
  if (known) return;
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM devices WHERE company_id = ? AND COALESCE(last_sync_at, created_at) > ?").bind(u.company_id, since).first<{ n: number }>();
  if ((n?.n ?? 0) >= max) throw gqlError(`Tu licencia permite ${max} caja(s)/equipo(s) y ya están en uso. Contacta a soporte para ampliarla.`, "LICENSE_LIMIT");
}

async function touchDevice(ctx: Ctx, d: Record<string, unknown> | undefined) {
  if (!d || typeof d.id !== "string" || !DEVICE_ID_RE.test(d.id)) return;
  const u = ctx.user!;
  // Sólo el equipo con el que se inició sesión: evita llenar la tabla con ids aleatorios.
  if (u.device_id && u.device_id !== d.id) return;
  const s = (v: unknown, n = 80) => (v == null ? null : String(v).slice(0, n));
  const terminalCode = s(d.terminalCode, 40);
  const section = s(d.section, 40);
  const macAddress = s(d.macAddress, 64);
  const hardwareId = s(d.hardwareId, 128);
  await env.DB.prepare(
    `INSERT INTO devices (id, company_id, user_id, name, platform, app_version, last_cursor, pending, last_sync_at, terminal_code, section, mac_address, hardware_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, name = excluded.name, platform = excluded.platform,
       app_version = excluded.app_version, last_cursor = excluded.last_cursor, pending = excluded.pending, last_sync_at = excluded.last_sync_at,
       terminal_code = COALESCE(NULLIF(excluded.terminal_code,''), devices.terminal_code),
       section = COALESCE(NULLIF(excluded.section,''), devices.section),
       mac_address = COALESCE(NULLIF(excluded.mac_address,''), devices.mac_address),
       hardware_id = COALESCE(NULLIF(excluded.hardware_id,''), devices.hardware_id)
     WHERE devices.company_id = excluded.company_id`,
  )
    .bind(d.id, u.company_id, u.id, s(d.name), s(d.platform, 20), s(d.appVersion, 20), Number(d.cursor) || 0, Number(d.pending) || 0, nowIso(), terminalCode, section, macAddress, hardwareId)
    .run();
}

export const syncSchema = addResolvers(buildSchema(typeDefs), {
  Query: {
    status: async (_s, _a, ctx) => {
      const u = requireUser(ctx.user);
      return {
        head: await headRev(env.DB, u.company_id),
        serverTime: nowIso(),
        role: u.role,
        maxPush: MAX_PUSH,
        tables: TABLE_NAMES.filter((t) => canRead(u, t)),
      };
    },
    pull: async (_s, a, ctx) => {
      const u = requireUser(ctx.user);
      await assertDeviceAllowed(u, a.device);
      const since = Math.max(0, Math.trunc(Number(a.since)) || 0);
      const result = await pullChanges(env.DB, u, since, Number(a.limit) || 500);
      await touchDevice(ctx, a.device);
      return { ...result, serverTime: nowIso() };
    },
  },
  Mutation: {
    push: async (_s, a, ctx) => {
      const u = requireUser(ctx.user);
      // Un solo push por request (evita multiplicar el lote con alias).
      if (ctx._pushed) throw gqlError("Sólo se permite un push por solicitud");
      ctx._pushed = true;
      const changes = a.changes as { table: string; row: Record<string, unknown> }[];
      if (changes.length > MAX_PUSH) throw gqlError(`Máximo ${MAX_PUSH} cambios por envío`);
      const accepted: PreparedRow[] = [];
      const rejected: Rejection[] = [];
      for (const ch of changes) {
        const row = ch.row && typeof ch.row === "object" && !Array.isArray(ch.row) ? ch.row : {};
        const r = prepareChange(u, ch.table, row);
        if ("values" in r) accepted.push(r);
        else rejected.push(r);
      }
      const fkRejected = await writeRowsTolerant(env.DB, u.company_id, accepted);
      rejected.push(...fkRejected);
      return { accepted: accepted.length - fkRejected.length, rejected, head: await headRev(env.DB, u.company_id), serverTime: nowIso() };
    },
  },
});
