// Maestro: POST /license/verify — los backends esclavos consultan aquí el estado de su llave.
import type express from "express";
import { licenseState } from "../shared/auth";
import { nowIso } from "../shared/crypto";
import { env } from "../shared/env";
import { parseJson } from "../shared/suites";

const KEY_RE = /^KIO-[A-F0-9]{6}(-[A-F0-9]{6}){3}$/;

export function mountLicensing(app: express.Express) {
  app.post("/license/verify", async (req, res) => {
    const key = String(req.body?.key ?? "").trim().toUpperCase();
    const none = { valid: false, status: "unknown", starts_at: null, ends_at: null, max_devices: null, max_users: null, modules: null, message: "Llave de licencia inválida." };
    if (!KEY_RE.test(key)) {
      res.status(200).json(none);
      return;
    }
    const l = await env.DB.prepare("SELECT * FROM licenses WHERE license_key = ?").bind(key).first<Record<string, any>>();
    if (!l) {
      res.status(200).json(none);
      return;
    }
    const state = licenseState(l as { status: string; starts_at: string | null; ends_at: string | null });
    if (l.kind === "remote") {
      const num = (v: unknown) => Math.max(0, Math.min(100000, Math.trunc(Number(v)) || 0));
      await env.DB.prepare("UPDATE licenses SET last_check_at = ?, last_usage = ? WHERE id = ?")
        .bind(nowIso(), JSON.stringify({ devices: num(req.body?.devices), users: num(req.body?.users) }), l.id)
        .run();
    }
    res.json({
      valid: !state,
      status: l.status,
      starts_at: l.starts_at,
      ends_at: l.ends_at,
      max_devices: l.max_devices,
      max_users: l.max_users,
      modules: l.modules ? parseJson<string[]>(l.modules, []) : null,
      message: state?.message ?? null,
    });
  });
}
