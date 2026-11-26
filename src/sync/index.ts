// Worker "kio-sbs-sync": endpoint de sincronización standalone (compatibilidad).
// El sync también está montado en el API principal en /sync/graphql para un solo backend.
import { httpServerHandler } from "cloudflare:node";
import { nowIso } from "../shared/crypto";
import { createApp } from "../shared/http";
import { syncSchema } from "./schema";

export { syncSchema };

const app = createApp("kio-sbs-sync", syncSchema);
app.listen(8080);
const handler = httpServerHandler({ port: 8080 });

export default {
  fetch: handler.fetch,
  /** Cron diario: limpia sesiones vencidas. */
  async scheduled(_event: ScheduledController, workerEnv: { DB: D1Database }) {
    await workerEnv.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(nowIso()).run();
  },
} satisfies ExportedHandler<{ DB: D1Database }>;
