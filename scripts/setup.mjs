#!/usr/bin/env node
// Asistente de instalación de KIO SBS Backend.
//   npm run setup
// Pregunta si esta instalación es PRINCIPAL (maestro, emite licencias) o ESCLAVA (valida su
// licencia contra tu maestro) y genera la configuración de Cloudflare correspondiente.
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const rl = createInterface({ input, output });
const ask = async (q, def = "") => ((await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim() || def);
const yes = async (q, def = "s") => /^(s|si|sí|y|yes)$/i.test(await ask(`${q} (s/n)`, def));
const run = (cmd) => execSync(cmd, { stdio: "inherit" });

const readJsonc = (f) => JSON.parse(readFileSync(f, "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n").replace(/,(\s*[}\]])/g, "$1"));

console.log("\n=== KIO SBS · Instalación ===\n");
const tipo = (await ask("¿Esta instalación es PRINCIPAL (maestro) o ESCLAVA? (principal/esclavo)", "principal")).toLowerCase();

if (!tipo.startsWith("e")) {
  console.log("\nModo PRINCIPAL: emite y controla licencias desde el admin (Sistema → Licencias).");
  console.log("Despliegue:  npm run deploy:all");
  console.log("Secreto de aprovisionamiento:  npx wrangler secret put PROVISION_TOKEN -c wrangler.api.jsonc\n");
  rl.close();
  process.exit(0);
}

console.log("\nModo ESCLAVO: este backend consulta la licencia a tu maestro. Necesitas la URL del maestro y la llave (KIO-XXXXXX-…).\n");
const master = (await ask("URL del backend maestro (ej. https://kio-sbs-backend.tuusuario.workers.dev)")).replace(/\/+$/, "");
const key = (await ask("Llave de licencia")).toUpperCase();
if (!/^https:\/\//.test(master)) throw new Error("La URL del maestro debe empezar con https://");
if (!/^KIO-[A-F0-9]{6}(-[A-F0-9]{6}){3}$/.test(key)) throw new Error("La llave no tiene el formato KIO-XXXXXX-XXXXXX-XXXXXX-XXXXXX");

process.stdout.write("Verificando la llave con el maestro… ");
try {
  const r = await (await fetch(`${master}/license/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) })).json();
  if (!r.valid) {
    console.log(`\n✗ ${r.message ?? "La licencia no es válida."} (estado: ${r.status})`);
    if (!(await yes("¿Continuar de todos modos?", "n"))) process.exit(1);
  } else console.log(`✓ válida${r.ends_at ? ` hasta ${r.ends_at}` : ""}${r.max_devices ? ` · ${r.max_devices} caja(s)` : ""}`);
} catch (e) {
  console.log(`\n✗ No se pudo contactar al maestro (${e.message}).`);
  if (!(await yes("¿Continuar de todos modos?", "n"))) process.exit(1);
}

const worker = await ask("Nombre del Worker en tu Cloudflare", "kio-sbs-cliente");
const dbName = await ask("Nombre de la base D1", `${worker}-db`);

const cfg = readJsonc("wrangler.api.jsonc");
cfg.name = worker;
cfg.vars = { ...cfg.vars, APP_NAME: worker, MODE: "slave", MASTER_URL: master, ALLOW_SIGNUP: "false" };
delete cfg.services; // el binding ADMIN sólo existe en el maestro
cfg.d1_databases = [{ binding: "DB", database_name: dbName, database_id: "REEMPLAZAR", migrations_dir: "migrations" }];

if (await yes("¿Crear la base D1 ahora con wrangler?")) {
  const out = execSync(`npx wrangler d1 create ${dbName}`, { encoding: "utf8" });
  console.log(out);
  const id = /"?database_id"?\s*[:=]\s*"([0-9a-f-]{36})"/i.exec(out)?.[1];
  if (id) cfg.d1_databases[0].database_id = id;
  else console.log("No pude leer el database_id: edítalo a mano en wrangler.slave.jsonc.");
}
writeFileSync("wrangler.slave.jsonc", JSON.stringify(cfg, null, 2) + "\n");
console.log("\n✓ Generado wrangler.slave.jsonc");

if (cfg.d1_databases[0].database_id !== "REEMPLAZAR" && (await yes("¿Aplicar migraciones, guardar la llave como secreto y desplegar ahora?"))) {
  run(`npx wrangler d1 migrations apply ${dbName} --remote -c wrangler.slave.jsonc`);
  execSync("npx wrangler secret put LICENSE_KEY -c wrangler.slave.jsonc", { input: key, stdio: ["pipe", "inherit", "inherit"] });
  const provToken = randomBytes(24).toString("hex");
  execSync("npx wrangler secret put PROVISION_TOKEN -c wrangler.slave.jsonc", { input: provToken, stdio: ["pipe", "inherit", "inherit"] });
  const out = execSync("npx wrangler deploy -c wrangler.slave.jsonc", { encoding: "utf8" });
  console.log(out);
  const url = /https:\/\/[^\s]+\.workers\.dev/.exec(out)?.[0];
  console.log("✓ Desplegado" + (url ? `: ${url}` : ""));
  if (url && (await yes("¿Crear ahora la empresa del cliente y su administrador?"))) {
    const company = await ask("Nombre de la empresa del cliente");
    const aname = await ask("Nombre del administrador");
    const email = await ask("Correo del administrador");
    const password = (await ask("Contraseña (vacío = generar una)")) || `Kio${randomBytes(4).toString("hex")}9`;
    const res = await fetch(`${url}/provision`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Provision-Token": provToken },
      body: JSON.stringify({ company: { name: company, email }, admin: { name: aname, email, password } }),
    });
    console.log(res.ok ? `✓ Empresa creada. Usuario: ${email} · Contraseña: ${password}` : `✗ No se pudo crear (${res.status}): ${await res.text()}`);
  }
  console.log("\nEn el POS pon la URL del Worker y entra con ese administrador. Para suspender o renovar, usa el admin del maestro.");
} else {
  console.log("\nPasos manuales:");
  console.log(`  npx wrangler d1 migrations apply ${dbName} --remote -c wrangler.slave.jsonc`);
  console.log("  npx wrangler secret put LICENSE_KEY -c wrangler.slave.jsonc   # pega la llave");
  console.log("  npx wrangler deploy -c wrangler.slave.jsonc");
}
rl.close();
