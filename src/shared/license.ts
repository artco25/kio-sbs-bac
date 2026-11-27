// Modo esclavo: este backend valida su licencia contra el maestro (MASTER_URL + LICENSE_KEY).
// Resultado cacheado en D1 (license_cache) y en memoria; si el maestro no responde se opera
// con la última respuesta buena hasta GRACE_DAYS días.
import { nowIso } from "./crypto";
import { env } from "./env";
import { licenseState, type LicenseInfo } from "./auth";
import { parseJson, type SuiteKey } from "./suites";

const REFRESH_MS = 10 * 60_000;
const RETRY_MS = 2 * 60_000;
const GRACE_DAYS = 7;
const MEM_MS = 20_000;

export const isSlave = () => env.MODE === "slave";

interface Payload {
  valid: boolean;
  status: string;
  starts_at: string | null;
  ends_at: string | null;
  max_devices: number | null;
  max_users: number | null;
  modules: SuiteKey[] | null;
  message?: string | null;
}

let mem: { at: number; lic: LicenseInfo } | null = null;

const toInfo = (p: Payload): LicenseInfo => {
  const err = !p.valid ? { code: "LICENSE_SUSPENDED", message: p.message || "Licencia no válida. Contacta a soporte." } : licenseState(p);
  return { status: p.status, starts_at: p.starts_at, ends_at: p.ends_at, max_devices: p.max_devices, max_users: p.max_users, modules: p.modules, error: err };
};

const blocked = (code: string, message: string): LicenseInfo => ({
  status: "suspended", starts_at: null, ends_at: null, max_devices: null, max_users: null, modules: null, error: { code, message },
});

async function usage() {
  const d = await env.DB.prepare("SELECT COUNT(*) AS n FROM devices").first<{ n: number }>();
  const u = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE active = 1 AND platform_role IS NULL").first<{ n: number }>();
  return { devices: d?.n ?? 0, users: u?.n ?? 0 };
}

export async function slaveLicense(): Promise<LicenseInfo> {
  if (mem && Date.now() - mem.at < MEM_MS) return mem.lic;
  const set = (lic: LicenseInfo) => ((mem = { at: Date.now(), lic }), lic);
  const key = env.LICENSE_KEY?.trim();
  const master = env.MASTER_URL?.trim().replace(/\/+$/, "");
  if (!key || !master) return set(blocked("LICENSE_UNCONFIGURED", "Esta instalación no tiene llave de licencia configurada."));

  const row = await env.DB.prepare("SELECT payload, checked_at, ok_at FROM license_cache WHERE id = 1").first<{ payload: string; checked_at: string; ok_at: string }>();
  if (row && Date.now() - new Date(row.checked_at).getTime() < REFRESH_MS) {
    return set(toInfo(parseJson<Payload>(row.payload, null as never)));
  }
  try {
    const r = await fetch(`${master}/license/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, ...(await usage()) }),
      signal: AbortSignal.timeout(8000),
    });
    const p = (await r.json()) as Payload;
    if (!r.ok || typeof p?.valid !== "boolean") throw new Error(`HTTP ${r.status}`);
    const now = nowIso();
    await env.DB.prepare(
      `INSERT INTO license_cache (id, payload, checked_at, ok_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, checked_at = excluded.checked_at, ok_at = excluded.ok_at`,
    ).bind(JSON.stringify(p), now, now).run();
    return set(toInfo(p));
  } catch {
    // Maestro inaccesible: se usa la última respuesta buena dentro del periodo de gracia.
    if (row && Date.now() - new Date(row.ok_at).getTime() < GRACE_DAYS * 86_400_000) {
      await env.DB.prepare("UPDATE license_cache SET checked_at = ? WHERE id = 1")
        .bind(new Date(Date.now() - REFRESH_MS + RETRY_MS).toISOString()).run();
      return set(toInfo(parseJson<Payload>(row.payload, null as never)));
    }
    return set(blocked("LICENSE_UNVERIFIED", "No se pudo verificar la licencia con el servidor principal. Revisa la conexión."));
  }
}
