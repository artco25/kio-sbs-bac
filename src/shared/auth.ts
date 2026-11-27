import { GraphQLError } from "graphql";
import { hashPassword, nowIso, randomHex, sha256Hex, uuid, verifyPassword } from "./crypto";
import { env } from "./env";
import { DEFAULT_SUITES, parseJson, type Perms, type SuiteKey } from "./suites";
import { isSlave, slaveLicense } from "./license";
import type { Role } from "./sync";

export type PlatformRole = 'owner' | 'admin' | 'viewer';

/** Licencia vigente de la empresa (null = empresa directa, sin límites). */
export interface LicenseInfo {
  status: string;
  starts_at: string | null;
  ends_at: string | null;
  max_devices: number | null;
  max_users: number | null;
  modules: SuiteKey[] | null;
  /** Si no es null, la empresa no puede operar (suspendida, vencida o aún no iniciada). */
  error: { code: string; message: string } | null;
}

/** Fecha de hoy en Colombia (UTC-5) como YYYY-MM-DD. */
export const todayCo = () => new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);

export function licenseState(l: { status: string; starts_at: string | null; ends_at: string | null }) {
  const today = todayCo();
  if (l.status !== "active") return { code: "LICENSE_SUSPENDED", message: "La licencia de la empresa está suspendida. Contacta a soporte." };
  if (l.starts_at && today < l.starts_at) return { code: "LICENSE_NOT_STARTED", message: `La licencia inicia el ${l.starts_at}.` };
  if (l.ends_at && today > l.ends_at) return { code: "LICENSE_EXPIRED", message: `La licencia venció el ${l.ends_at}. Contacta a soporte para renovarla.` };
  return null;
}

export interface AuthUser {
  id: string;
  company_id: string;
  company_name: string;
  name: string;
  email: string;
  role: Role;
  employee_id: string | null;
  pos_terminal: string | null;
  session_id: string;
  device_id: string | null;
  role_id: string | null;
  role_name: string | null;
  /** Matriz del rol personalizado (null = permisos del rol base). */
  perms: Perms | null;
  suites: SuiteKey[];
  platform_role: PlatformRole | null;
  site_id: string | null;
  license: LicenseInfo | null;
}

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const TOUCH_EVERY_MS = 60 * 60_000;
/** Vigencia absoluta: aunque se use a diario, un token caduca a los 90 días de creado. */
const ABSOLUTE_DAYS = 90;
const BAD_LOGIN = "Credenciales inválidas o cuenta bloqueada temporalmente";

export const gqlError = (message: string, code = "BAD_REQUEST") => new GraphQLError(message, { extensions: { code } });

export function bearer(header: string | undefined) {
  const m = /^Bearer\s+([A-Fa-f0-9]{64})$/.exec(header ?? "");
  return m ? m[1] : null;
}

const sessionDays = () => Math.min(Math.max(Number(env.SESSION_DAYS) || 30, 1), 90);
const addDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

export async function authenticate(token: string | null): Promise<AuthUser | null> {
  if (!token) return null;
  const now = nowIso();
  const row = await env.DB.prepare(
    `SELECT s.id AS session_id, s.device_id, s.last_seen_at, u.id, u.company_id, u.name, u.email, u.role, u.employee_id, u.pos_terminal,
            u.platform_role, u.site_id, c.name AS company_name, u.role_id, r.name AS role_name, r.base_role, r.suites AS role_suites, r.permissions AS role_permissions,
            l.status AS lic_status, l.starts_at AS lic_starts, l.ends_at AS lic_ends, l.max_devices AS lic_max_devices, l.max_users AS lic_max_users, l.modules AS lic_modules
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN companies c ON c.id = u.company_id
       LEFT JOIN roles r ON r.id = u.role_id AND r.company_id = u.company_id
       LEFT JOIN licenses l ON l.company_id = u.company_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND s.created_at > ? AND u.active = 1 AND c.active = 1`,
  )
    .bind(await sha256Hex(token), now, new Date(Date.now() - ABSOLUTE_DAYS * 86_400_000).toISOString())
    .first<RawUser & { last_seen_at: string }>();
  if (!row) return null;
  // Expiración deslizante: renueva como máximo una vez por hora para no escribir en cada request.
  if (Date.now() - new Date(row.last_seen_at).getTime() > TOUCH_EVERY_MS) {
    await env.DB.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?")
      .bind(now, addDays(sessionDays()), row.session_id)
      .run();
  }
  const user = withRole(row);
  // Esclavo: la licencia viene del maestro y aplica a toda la instalación.
  return isSlave() ? applyLicense(user, await slaveLicense()) : user;
}

type RawUser = Omit<AuthUser, "perms" | "suites" | "license"> & {
  base_role: Role | null;
  role_suites: string | null;
  role_permissions: string | null;
  lic_status?: string | null;
  lic_starts?: string | null;
  lic_ends?: string | null;
  lic_max_devices?: number | null;
  lic_max_users?: number | null;
  lic_modules?: string | null;
};

/** Rol efectivo: el rol personalizado de la empresa (si tiene) define suites y permisos; si no, los del rol base. */
export function withRole(row: RawUser & { last_seen_at?: string }): AuthUser {
  const { last_seen_at: _a, base_role, role_suites, role_permissions, lic_status, lic_starts, lic_ends, lic_max_devices, lic_max_users, lic_modules, ...u } = row;
  const role = (row.role_id && base_role) || u.role;
  const license: LicenseInfo | null = lic_status
    ? {
        status: lic_status,
        starts_at: lic_starts ?? null,
        ends_at: lic_ends ?? null,
        max_devices: lic_max_devices ?? null,
        max_users: lic_max_users ?? null,
        modules: lic_modules ? parseJson<SuiteKey[] | null>(lic_modules, null) : null,
        error: licenseState({ status: lic_status, starts_at: lic_starts ?? null, ends_at: lic_ends ?? null }),
      }
    : null;
  const suites = row.role_id && base_role ? parseJson<SuiteKey[]>(role_suites, []) : DEFAULT_SUITES[role];
  return applyLicense(
    { ...u, role, license: null, perms: row.role_id && base_role ? parseJson<Perms>(role_permissions, {}) : null, suites },
    license,
  );
}

/** Asigna la licencia y recorta las suites a los módulos licenciados (los dueños de plataforma no se restringen). */
export function applyLicense(u: AuthUser, license: LicenseInfo | null): AuthUser {
  u.license = license;
  if (license?.modules && !u.platform_role) u.suites = u.suites.filter((x) => license.modules!.includes(x) || x === "sistema");
  return u;
}

export function requireUser(user: AuthUser | null, roles?: Role[]): AuthUser {
  if (!user) throw gqlError("Sesión no válida o vencida", "UNAUTHENTICATED");
  // Licencia suspendida/vencida: la empresa no opera (los dueños de plataforma sí pueden entrar a administrarla).
  if (user.license?.error && !user.platform_role) throw gqlError(user.license.error.message, user.license.error.code);
  if (roles && !roles.includes(user.role)) throw gqlError("No tienes permiso para esta acción", "FORBIDDEN");
  return user;
}

// Hash de referencia para igualar el tiempo de respuesta cuando el correo no existe.
let dummyHash: Promise<string> | null = null;

export const normEmail = (e: unknown) => String(e ?? "").trim().toLowerCase();

export async function login(emailRaw: string, password: string, deviceId: string | null) {
  const email = normEmail(emailRaw);
  if (!email || !password) throw gqlError("Correo y contraseña son obligatorios");
  const now = nowIso();
  const u = await env.DB.prepare(
    `SELECT u.*, c.name AS company_name FROM users u JOIN companies c ON c.id = u.company_id
      WHERE u.email = ? AND u.active = 1 AND c.active = 1`,
  )
    .bind(email)
    .first<AuthUser & { password_hash: string; failed_logins: number; locked_until: string | null }>();

  // Mismo mensaje y mismo costo (PBKDF2) para correo inexistente, clave mala o cuenta bloqueada:
  // no se puede enumerar usuarios por la respuesta ni por el tiempo.
  if (!u) {
    dummyHash ??= hashPassword(randomHex(8));
    await verifyPassword(password, await dummyHash);
    throw gqlError(BAD_LOGIN, "UNAUTHENTICATED");
  }
  const valid = await verifyPassword(password, u.password_hash);
  if (u.locked_until && u.locked_until > now) throw gqlError(BAD_LOGIN, "UNAUTHENTICATED");
  if (!valid) {
    // Incremento atómico: intentos en paralelo no pueden saltarse el bloqueo.
    await env.DB.prepare(
      `UPDATE users SET
         locked_until = CASE WHEN failed_logins + 1 >= ? THEN ? ELSE locked_until END,
         failed_logins = CASE WHEN failed_logins + 1 >= ? THEN 0 ELSE failed_logins + 1 END
       WHERE id = ?`,
    )
      .bind(MAX_FAILED, new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString(), MAX_FAILED, u.id)
      .run();
    throw gqlError(BAD_LOGIN, "UNAUTHENTICATED");
  }

  const token = randomHex(32);
  const expiresAt = addDays(sessionDays());
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?").bind(now, u.id),
    env.DB.prepare("INSERT INTO sessions (id, user_id, token_hash, device_id, expires_at) VALUES (?, ?, ?, ?, ?)").bind(
      uuid(),
      u.id,
      await sha256Hex(token),
      deviceId ? String(deviceId).slice(0, 64) : null,
      expiresAt,
    ),
  ]);
  return { token, expiresAt, userId: u.id };
}

export function validatePassword(pw: string) {
  if (typeof pw !== "string" || pw.length < 8) throw gqlError("La contraseña debe tener al menos 8 caracteres");
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw gqlError("La contraseña debe combinar letras y números");
}
