#!/usr/bin/env node
// Cambia la contraseña de un usuario en la D1 LOCAL y limpia intentos fallidos/bloqueo.
//   node scripts/dev-password.mjs                → pide correo (por defecto DEV_ADMIN_EMAIL) y clave
//   node scripts/dev-password.mjs correo@x.co    → pide sólo la clave
import { execFileSync } from "node:child_process";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const varsPath = resolve(root, ".dev.vars");
let vars = "";
try {
  vars = readFileSync(varsPath, "utf8");
} catch {}
const defEmail = /^DEV_ADMIN_EMAIL=(.*)$/m.exec(vars)?.[1]?.trim() || "admin@artix.co";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const email = (process.argv[2] || (await rl.question(`Correo [${defEmail}]: `)) || defEmail).trim().toLowerCase();
// Oculta lo que se escribe en la clave
const ask = rl.question("Nueva contraseña (mín. 8, letras y números): ");
rl._writeToOutput = (s) => rl.output.write(s.includes("contraseña") ? s : "");
const pass = (await ask).trim();
rl.close();
process.stdout.write("\n");

if (pass.length < 8 || !/[A-Za-z]/.test(pass) || !/\d/.test(pass)) {
  console.error("❌ Debe tener al menos 8 caracteres con letras y números");
  process.exit(1);
}
if (!/^[^\s@']+@[^\s@']+\.[^\s@']+$/.test(email)) {
  console.error("❌ Correo inválido");
  process.exit(1);
}

const salt = randomBytes(16);
const hash = `pbkdf2$100000$${salt.toString("hex")}$${pbkdf2Sync(pass, salt, 100000, 32, "sha256").toString("hex")}`;
const d1 = (sql) =>
  JSON.parse(
    execFileSync("npx", ["wrangler", "d1", "execute", "kio-sbs", "--local", "-c", "wrangler.api.jsonc", "--json", "--command", sql], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  )[0]?.results ?? [];
d1(`UPDATE users SET password_hash='${hash}', failed_logins=0, locked_until=NULL WHERE email='${email}'`);
if (d1(`SELECT id FROM users WHERE email='${email}' AND password_hash='${hash}'`).length !== 1) {
  console.error(`❌ No existe ${email} en la D1 local. Créalo con: bash scripts/dev-seed.sh`);
  process.exit(1);
}
if (email === defEmail && /^DEV_ADMIN_PASSWORD=/m.test(vars)) {
  writeFileSync(varsPath, vars.replace(/^DEV_ADMIN_PASSWORD=.*$/m, `DEV_ADMIN_PASSWORD=${pass}`));
}
console.log(`✅ Contraseña actualizada para ${email} (D1 local)`);
