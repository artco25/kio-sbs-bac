// Actualizaciones del POS servidas por el mismo backend Express:
// GET /downloads/release.json y /downloads/<archivo> se resuelven contra el admin (assets estáticos).
import type express from "express";
import { env } from "../shared/env";

const ALLOWED = /^(release\.json|kio-sbs-pos-[a-z0-9._-]+\.(tar\.gz|zip|exe|msi))$/i;

export function mountDownloads(app: express.Express, adminUrl: string) {
  app.get("/downloads/:file", async (req, res) => {
    const file = String(req.params.file ?? "");
    if (!ALLOWED.test(file)) {
      res.status(404).json({ error: "No encontrado" });
      return;
    }
    try {
      // workers.dev no permite fetch entre Workers de la misma cuenta: se usa el service binding.
      const target = `${adminUrl.replace(/\/+$/, "")}/downloads/${file}`;
      const r = env.ADMIN ? await env.ADMIN.fetch(target) : await fetch(target);
      const type = r.headers.get("content-type") ?? "";
      if (!r.ok || type.includes("text/html")) {
        res.status(404).json({ error: "No encontrado" });
        return;
      }
      res.status(200);
      res.setHeader("Content-Type", file.endsWith(".json") ? "application/json" : "application/octet-stream");
      res.setHeader("Cache-Control", file.endsWith(".json") ? "no-cache" : "public, max-age=3600");
      res.send(Buffer.from(await r.arrayBuffer()));
    } catch {
      res.status(502).json({ error: "Origen de actualizaciones no disponible" });
    }
  });
}
