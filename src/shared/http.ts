import express, { type NextFunction, type Request, type Response } from "express";
import {
  GraphQLError,
  GraphQLObjectType,
  GraphQLScalarType,
  Kind,
  defaultFieldResolver,
  execute,
  valueFromASTUntyped,
  type GraphQLFieldResolver,
  type GraphQLSchema,
  type SelectionSetNode,
  type ValidationRule,
} from "graphql";
import { createHandler } from "graphql-http/lib/use/express";
import { authenticate, bearer, type AuthUser } from "./auth";
import { env } from "./env";

export interface Ctx extends Record<PropertyKey, unknown> {
  user: AuthUser | null;
  ip: string | null;
  deviceId: string | null;
}

type ReqWithUser = Request & { user?: AuthUser | null };

// ------------------------------------------------------------------ GraphQL utils

/** Asigna resolvers a un esquema construido con buildSchema (SDL). */
export function addResolvers(schema: GraphQLSchema, map: Record<string, Record<string, GraphQLFieldResolver<any, Ctx>>>) {
  for (const [typeName, fields] of Object.entries(map)) {
    const type = schema.getType(typeName);
    if (!(type instanceof GraphQLObjectType)) throw new Error(`Tipo ${typeName} no existe`);
    const defs = type.getFields();
    for (const [field, fn] of Object.entries(fields)) {
      if (!defs[field]) throw new Error(`Campo ${typeName}.${field} no existe`);
      defs[field].resolve = fn;
    }
  }
  const json = schema.getType("JSON");
  if (json instanceof GraphQLScalarType) {
    Object.assign(json, {
      serialize: (v: unknown) => v,
      parseValue: (v: unknown) => v,
      parseLiteral: (ast: Parameters<typeof valueFromASTUntyped>[0], vars?: Record<string, unknown>) => valueFromASTUntyped(ast, vars),
    });
  }
  return schema;
}

const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** camelCase en GraphQL ↔ snake_case en D1, sin escribir un resolver por campo. */
const snakeFieldResolver: GraphQLFieldResolver<any, Ctx> = (src, args, ctx, info) => {
  if (src && typeof src === "object" && !(info.fieldName in src)) {
    const key = snake(info.fieldName);
    if (key in src) return src[key];
  }
  return defaultFieldResolver(src, args, ctx, info);
};

/**
 * Rechaza operaciones abusivas: profundidad > maxDepth, más de maxRoot campos raíz (alias)
 * o más de maxFields campos en total. Los fragmentos se expanden por ruta (un fragmento
 * reutilizado cuenta cada vez) y los ciclos se cortan.
 */
export function costLimit(maxDepth: number, maxRoot: number, maxFields: number): ValidationRule {
  return (context) => {
    let fields = 0;
    const measure = (set: SelectionSetNode | undefined, depth: number, path: Set<string>): number => {
      if (!set || fields > maxFields) return depth;
      let deepest = depth;
      for (const sel of set.selections) {
        if (sel.kind === Kind.FIELD) {
          fields++;
          deepest = Math.max(deepest, sel.selectionSet ? measure(sel.selectionSet, depth + 1, path) : depth);
        } else if (sel.kind === Kind.INLINE_FRAGMENT) {
          deepest = Math.max(deepest, measure(sel.selectionSet, depth, path));
        } else if (!path.has(sel.name.value)) {
          const next = new Set(path).add(sel.name.value);
          deepest = Math.max(deepest, measure(context.getFragment(sel.name.value)?.selectionSet, depth, next));
        }
      }
      return deepest;
    };
    return {
      OperationDefinition(node) {
        fields = 0;
        const roots = node.selectionSet.selections.length;
        const d = measure(node.selectionSet, 0, new Set());
        const fail = (msg: string) => context.reportError(new GraphQLError(msg, { nodes: [node] }));
        if (roots > maxRoot) fail(`Demasiados campos raíz en una operación (${roots} > ${maxRoot})`);
        if (d > maxDepth) fail(`Consulta demasiado profunda (${d} > ${maxDepth})`);
        if (fields > maxFields) fail(`Consulta demasiado grande (más de ${maxFields} campos)`);
      },
    };
  };
}

// ------------------------------------------------------------------ Express app

function cors(req: Request, res: Response, next: NextFunction) {
  const allowed = (env.CORS_ORIGIN ?? "*").split(",").map((s) => s.trim());
  const origin = req.headers.origin;
  if (allowed.includes("*")) res.setHeader("Access-Control-Allow-Origin", "*");
  else if (origin && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Device-Id, X-Provision-Token");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}

export function createApp(service: string, schema: GraphQLSchema, setup?: (app: express.Express) => void) {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors);
  app.use(express.json({ limit: "2mb" }));

  // Autenticación por token Bearer (opcional: cada resolver decide si la exige)
  app.use(async (req: ReqWithUser, _res, next) => {
    try {
      req.user = await authenticate(bearer(req.headers.authorization));
      next();
    } catch (e) {
      next(e);
    }
  });

  app.get(["/", "/health"], async (_req, res) => {
    const row = await env.DB.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now").first<{ now: string }>();
    res.json({ service, status: "ok", db: "d1", now: row?.now ?? null });
  });

  setup?.(app);

  app.all(
    "/graphql",
    createHandler<Ctx>({
      schema,
      context: (req) => {
        const raw = req.raw as ReqWithUser;
        return {
          user: raw.user ?? null,
          ip: (raw.headers["cf-connecting-ip"] as string) ?? null,
          deviceId: ((raw.headers["x-device-id"] as string) ?? "").slice(0, 64) || null,
        };
      },
      validationRules: (_req, _args, specified) => [...specified, costLimit(8, 12, 400)],
      execute: (args) => execute({ ...args, fieldResolver: snakeFieldResolver }),
      formatError: (err) => {
        // Errores de negocio (GraphQLError) se muestran; cualquier otro (SQL, bugs) se oculta.
        const original = (err as GraphQLError).originalError;
        if (original && !(original instanceof GraphQLError)) {
          console.error(`[${service}]`, original);
          return new GraphQLError("Error interno del servidor", { path: (err as GraphQLError).path, extensions: { code: "INTERNAL" } });
        }
        return err;
      },
    }),
  );

  app.use((_req, res) => {
    res.status(404).json({ error: "No encontrado" });
  });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(`[${service}]`, err);
    const status = (err as { status?: number })?.status ?? 500;
    res.status(status).json({ error: status === 500 ? "Error interno del servidor" : String((err as Error).message) });
  });
  return app;
}
