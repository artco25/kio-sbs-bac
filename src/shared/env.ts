import { env as cfEnv } from "cloudflare:workers";

export interface Env {
  DB: D1Database;
  /** Service binding al Worker del admin (assets estáticos: /downloads). */
  ADMIN?: Fetcher;
  APP_NAME?: string;
  /** Orígenes permitidos separados por coma ("*" = cualquiera). */
  CORS_ORIGIN?: string;
  /** Secreto para aprovisionar empresas (wrangler secret put PROVISION_TOKEN). */
  PROVISION_TOKEN?: string;
  /** "true" habilita el auto-registro de empresas (mutación signup). */
  ALLOW_SIGNUP?: string;
  /** Días de vigencia del token de sesión (por defecto 30). */
  SESSION_DAYS?: string;
}

/** Bindings del Worker accesibles desde cualquier handler de Express. */
export const env = cfEnv as unknown as Env;
export const db = () => env.DB;
