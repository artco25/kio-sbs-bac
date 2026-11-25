// Worker "kio-sbs-api": Express + GraphQL (consultas, autenticación, administración y panel KIO SBS).
import { httpServerHandler } from "cloudflare:node";
import { buildSchema } from "graphql";
import { addResolvers, createApp } from "../shared/http";
import { mountProvision } from "./provision";
import { resolvers } from "./resolvers";
import { typeDefs } from "./schema";

const schema = addResolvers(buildSchema(typeDefs), resolvers);
const app = createApp("kio-sbs-api", schema, mountProvision);

app.listen(8080);
export default httpServerHandler({ port: 8080 });
