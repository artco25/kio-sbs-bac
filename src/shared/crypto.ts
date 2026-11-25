const enc = new TextEncoder();
const PBKDF2_ITERATIONS = 100_000; // máximo soportado por Workers

const toHex = (buf: ArrayBuffer | Uint8Array) =>
  Array.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

const fromHex = (hex: string) => new Uint8Array((hex.match(/../g) ?? []).map((h) => parseInt(h, 16)));

export function randomHex(bytes = 32) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(text: string) {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

/** Formato: pbkdf2$<iteraciones>$<salHex>$<hashHex> */
export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toHex(salt)}$${toHex(hash)}`;
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPassword(password: string, stored: string) {
  const [algo, iter, saltHex, hashHex] = stored.split("$");
  if (algo !== "pbkdf2" || !iter || !saltHex || !hashHex) return false;
  const iterations = Number(iter);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS) return false;
  const hash = await pbkdf2(password, fromHex(saltHex), iterations);
  return constantTimeEqual(hash, fromHex(hashHex));
}

export function uuid() {
  return crypto.randomUUID();
}

/** Marca de tiempo ISO-8601 UTC con milisegundos (orden lexicográfico = cronológico). */
export function nowIso() {
  return new Date().toISOString();
}
