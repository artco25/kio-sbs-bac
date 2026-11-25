// Worker "kio-sbs-api": Express + GraphQL (consultas, autenticación, administración y panel KIO SBS).
import { httpServerHandler } from "cloudflare:node";
import { buildSchema } from "graphql";
import { addResolvers, createApp } from "../shared/http";
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

const app = createApp("kio-sbs-api", schema, (a) => {
  mountProvision(a);
  a.get("/openapi.json", (_req, res) => res.json(openapi));
  a.get("/docs", (_req, res) => res.type("html").send(SWAGGER_HTML));
});

app.listen(8080);
export default httpServerHandler({ port: 8080 });
