/** Documentación OpenAPI 3.0 de kio-sbs-api. Se sirve en /openapi.json y /docs. */
export const openapi = {
  openapi: "3.0.3",
  info: {
    title: "KIO SBS API",
    version: "1.0.0",
    description:
      "API de KIO SBS: Express + GraphQL sobre Cloudflare D1.\n\n" +
      "Autenticación por Bearer token (login → token). El endpoint /graphql acepta GET y POST.",
  },
  servers: [
    { url: "/", description: "Local" },
    { url: "https://kio-sbs.rmolina1529.workers.dev", description: "Producción" },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    "/": {
      get: {
        summary: "Health check",
        security: [],
        responses: { "200": { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Health" } } } } },
      },
    },
    "/health": {
      get: {
        summary: "Health check",
        security: [],
        responses: { "200": { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Health" } } } } },
      },
    },
    "/provision": {
      post: {
        summary: "Crear empresa (tenant) con administrador",
        description: "Protegido con header X-Provision-Token. Crea empresa, admin y datos demo opcionales.",
        security: [],
        parameters: [
          { in: "header", name: "X-Provision-Token", required: true, schema: { type: "string" }, description: "Secreto PROVISION_TOKEN" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["company", "admin"],
                properties: {
                  company: {
                    type: "object",
                    required: ["name"],
                    properties: { name: { type: "string" }, nit: { type: "string" }, city: { type: "string" }, phone: { type: "string" }, email: { type: "string" } },
                  },
                  admin: {
                    type: "object",
                    required: ["name", "email", "password"],
                    properties: { name: { type: "string" }, email: { type: "string" }, password: { type: "string" } },
                  },
                  demo: { type: "boolean", description: "Inserta datos demo (productos, categorías, socios, empleados)" },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "Empresa creada", content: { "application/json": { schema: { $ref: "#/components/schemas/ProvisionResponse" } } } },
          "400": { description: "Datos inválidos" },
          "401": { description: "Token inválido" },
          "409": { description: "Email ya existe" },
        },
      },
    },
    "/graphql": {
      post: {
        summary: "GraphQL (query y mutation)",
        description: "Consulta principal. Usa el header Authorization: Bearer <token> tras login.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["query"],
                properties: {
                  query: { type: "string", example: 'mutation { login(email: "admin@artix.co", password: "admin123") { token me { user { name role } } } }' },
                  variables: { type: "object" },
                  operationName: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Resultado GraphQL", content: { "application/json": { schema: { $ref: "#/components/schemas/GraphQLResponse" } } } },
          "400": { description: "Error GraphQL" },
        },
      },
      get: {
        summary: "GraphQL (query con parámetro query=)",
        parameters: [{ in: "query", name: "query", required: true, schema: { type: "string" }, description: "GraphQL query" }],
        responses: { "200": { description: "Resultado GraphQL" } },
      },
    },
    "/openapi.json": {
      get: { summary: "Especificación OpenAPI (JSON)", security: [], responses: { "200": { description: "OK" } } },
    },
    "/docs": {
      get: { summary: "Documentación Swagger UI", security: [], responses: { "200": { description: "OK" } } },
    },
  },
  schemas: {
    Health: {
      type: "object",
      properties: {
        service: { type: "string", example: "kio-sbs-api" },
        status: { type: "string", example: "ok" },
        db: { type: "string", example: "d1" },
        now: { type: "string", example: "2026-11-25T20:50:00.000Z" },
      },
    },
    ProvisionResponse: {
      type: "object",
      properties: {
        company: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } },
        admin: { type: "object", properties: { id: { type: "string" }, email: { type: "string" } } },
        rows: { type: "integer", description: "Filas insertadas (payroll_params + demo)" },
      },
    },
    GraphQLResponse: {
      type: "object",
      properties: {
        data: { type: "object", description: "Resultado de la query" },
        errors: { type: "array", items: { type: "object", properties: { message: { type: "string" } } } },
      },
    },
    AuthPayload: {
      type: "object",
      properties: {
        token: { type: "string" },
        expiresAt: { type: "string" },
        me: { type: "object", properties: { user: { type: "object" }, company: { type: "object" }, permissions: { type: "object" }, suites: { type: "array", items: { type: "string" } } } },
      },
    },
  },
} as const;
