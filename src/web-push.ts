// Web Push (RFC 8291 šifrovanie, RFC 8292 VAPID) cez WebCrypto. Odosiela Rust (`remote_push`).

export interface PushSubscriptionKeys {
  endpoint: string;
  /** Verejný kľúč prehliadača (P-256, nekomprimovaný bod) v base64url. */
  p256dh: string;
  /** Autentifikačné tajomstvo prehliadača v base64url. */
  auth: string;
}

/** Kľúč, ktorým desktop podpisuje správy; prehliadač prijme len správy podpísané týmto kľúčom. */
export interface VapidKeys {
  /** Nekomprimovaný verejný bod v base64url (`applicationServerKey` na mobile). */
  publicKey: string;
  privateJwk: JsonWebKey;
}

/** Push služby (Apple) chcú kontakt; používateľa neidentifikuje. */
const VAPID_SUBJECT = "https://github.com/dugynoo/project-desk";
const RECORD_SIZE = 4096;
const enc = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "").padEnd(Math.ceil(text.length / 4) * 4, "="));
  return Uint8Array.from(s, c => c.charCodeAt(0));
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, length: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

export async function createVapidKeys(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKey = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  return { publicKey, privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey) };
}

/** Hlavička `Authorization` pre push službu adresy `endpoint`, platná 12 hodín. */
export async function vapidAuthorization(endpoint: string, keys: VapidKeys, now = Date.now()): Promise<string> {
  const header = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: VAPID_SUBJECT })));
  const key = await crypto.subtle.importKey("jwk", keys.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${claims}`)));
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${keys.publicKey}`;
}

/**
 * Telo správy `aes128gcm` pre jeden odber. `local` a `salt` sú náhodné; testy ich zadajú,
 * aby sa dal porovnať príklad z RFC 8291.
 */
export async function encryptPayload(
  payload: Uint8Array<ArrayBuffer>,
  sub: Pick<PushSubscriptionKeys, "p256dh" | "auth">,
  local?: CryptoKeyPair,
  salt: Uint8Array<ArrayBuffer> = crypto.getRandomValues(new Uint8Array(16)),
): Promise<Uint8Array<ArrayBuffer>> {
  const ecdh = { name: "ECDH", namedCurve: "P-256" } as const;
  const pair = local ?? await crypto.subtle.generateKey(ecdh, true, ["deriveBits"]) as CryptoKeyPair;
  const uaPublic = fromB64url(sub.p256dh);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const peer = await crypto.subtle.importKey("raw", uaPublic, ecdh, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, pair.privateKey, 256));
  const ikm = await hkdf(fromB64url(sub.auth), secret, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // Jediný (posledný) záznam: za obsahom oddeľovač 0x02.
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(payload, Uint8Array.of(2))));
  const header = new Uint8Array(21);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  return concat(header, asPublic, cipher);
}
