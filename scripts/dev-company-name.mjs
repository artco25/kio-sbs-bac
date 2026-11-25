#!/usr/bin/env node
// Restaura el nombre de la empresa de desarrollo (por defecto "Artix"): node scripts/dev-company-name.mjs [nombre]
import { readFileSync } from "node:fs";

const API = process.env.API ?? "http://127.0.0.1:8797";
const vars = Object.fromEntries(
  readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const call = async (query, variables, token) =>
  (
    await fetch(`${API}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.8.8.8", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ query, variables }),
    })
  ).json();

const login = await call("mutation($e:String!,$p:String!){ login(email:$e,password:$p){ token } }", { e: vars.DEV_ADMIN_EMAIL, p: vars.DEV_ADMIN_PASSWORD });
const token = login.data.login.token;
const r = await call("mutation($i:CompanyInput!){ updateCompany(input:$i){ name nit } }", { i: { name: process.argv[2] ?? "Artix" } }, token);
console.log(JSON.stringify(r.data ?? r.errors));
