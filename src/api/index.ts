// Worker "kio-sbs-api": Express + GraphQL (consultas, autenticación, administración y panel KIO SBS).
import { httpServerHandler } from "cloudflare:node";
import { buildSchema, execute } from "graphql";
import { createHandler } from "graphql-http/lib/use/express";
import { nowIso } from "../shared/crypto";
import { addResolvers, costLimit, createApp, snakeFieldResolver, type Ctx } from "../shared/http";
import { syncSchema } from "../sync/schema";
import { mountProvision } from "./provision";
import { resolvers } from "./resolvers";
import { typeDefs } from "./schema";
import { openapi } from "./openapi";

const schema = addResolvers(buildSchema(typeDefs), resolvers);

const SWAGGER_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <title>KIO SBS API — Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>body{margin:0;background:#f9f9fc}</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.onload = () => {
      SwaggerUIBundle({ url: "/openapi.json", dom_id: "#swagger-ui", deepLinking: true, tryItOutEnabled: true });
    };
  </script>
</body>
</html>`;

const syncHandler = createHandler<Ctx>({
  schema: syncSchema,
  context: (req) => {
    const raw = req.raw as any;
    return {
      user: raw.user ?? null,
      ip: (raw.headers["cf-connecting-ip"] as string) ?? null,
      deviceId: ((raw.headers["x-device-id"] as string) ?? "").slice(0, 64) || null,
    };
  },
  validationRules: (_req, _args, specified) => [...specified, costLimit(8, 12, 400)],
  execute: (args) => execute({ ...args, fieldResolver: snakeFieldResolver }),
});

const app = createApp("kio-sbs-api", schema, (a) => {
  mountProvision(a);
  a.get("/openapi.json", (_req, res) => res.json(openapi));
  a.get("/docs", (_req, res) => res.type("html").send(SWAGGER_HTML));
  a.all(["/sync", "/sync/graphql"], syncHandler);
});

app.listen(8080);
const handler = httpServerHandler({ port: 8080 });

/** Un solo Worker: GraphQL + /sync/graphql + limpieza diaria de sesiones vencidas. */
export default {
  fetch: handler.fetch,
  async scheduled(_event: ScheduledController, workerEnv: { DB: D1Database }) {
    await workerEnv.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(nowIso()).run();
  },
} satisfies ExportedHandler<{ DB: D1Database }>;
