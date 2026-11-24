import { test } from "node:test";
import assert from "node:assert/strict";
import { b64url, createVapidKeys, encryptPayload, fromB64url, vapidAuthorization } from "./web-push.ts";

// RFC 8291, Appendix A.
const rfc = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

async function ecdhPair(priv: string, pub: string): Promise<CryptoKeyPair> {
  const point = fromB64url(pub);
  const jwk = { kty: "EC", crv: "P-256", x: b64url(point.slice(1, 33)), y: b64url(point.slice(33, 65)), d: priv };
  const alg = { name: "ECDH", namedCurve: "P-256" };
  return {
    privateKey: await crypto.subtle.importKey("jwk", jwk, alg, true, ["deriveBits"]),
    publicKey: await crypto.subtle.importKey("raw", point, alg, true, []),
  };
}

test("encryptPayload matches the RFC 8291 example", async () => {
  const local = await ecdhPair(rfc.asPrivate, rfc.asPublic);
  const body = await encryptPayload(new TextEncoder().encode(rfc.plaintext), { p256dh: rfc.uaPublic, auth: rfc.auth }, local, fromB64url(rfc.salt));
  assert.equal(b64url(body), rfc.body);
});

test("encryptPayload uses a fresh key and salt for every message", async () => {
  const sub = { p256dh: rfc.uaPublic, auth: rfc.auth };
  const a = await encryptPayload(new TextEncoder().encode("x"), sub);
  const b = await encryptPayload(new TextEncoder().encode("x"), sub);
  assert.notDeepEqual(a.slice(0, 16), b.slice(0, 16));
  assert.notDeepEqual(a.slice(21, 86), b.slice(21, 86));
  assert.equal(a[20], 65);
});

test("vapidAuthorization signs a JWT for the push service origin", async () => {
  const keys = await createVapidKeys();
  const header = await vapidAuthorization("https://web.push.apple.com/abc?x=1", keys, 1_700_000_000_000);
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
  assert.ok(m, header);
  assert.equal(m[4], keys.publicKey);
  const claims = JSON.parse(new TextDecoder().decode(fromB64url(m[2]!)));
  assert.deepEqual(claims, { aud: "https://web.push.apple.com", exp: 1_700_000_000 + 12 * 3600, sub: "https://github.com/dugynoo/project-desk" });
  const pub = await crypto.subtle.importKey("raw", fromB64url(keys.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, fromB64url(m[3]!), new TextEncoder().encode(`${m[1]}.${m[2]}`));
  assert.ok(ok);
});
