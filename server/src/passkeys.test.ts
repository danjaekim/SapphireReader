import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { fakeEngine } from "./test-engine.js";

const ORIGIN = "https://nas.tail1234.ts.net";
const RP = "nas.tail1234.ts.net";
const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");
const sha = (b: Buffer | Uint8Array) => createHash("sha256").update(b).digest();

/** A stand-in for the phone: makes a P-256 key and answers like an authenticator that did Face ID. */
function phone(rpID = RP, origin = ORIGIN) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const credId = randomBytes(16);
  let counter = 0;
  const client = (type: string, challenge: string, o = origin) => Buffer.from(JSON.stringify({ type, challenge, origin: o }));
  return {
    create(challenge: string, o = origin) {
      const cose = new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]);
      const idLen = Buffer.alloc(2);
      idLen.writeUInt16BE(credId.length);
      const authData = Buffer.concat([sha(Buffer.from(rpID)), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), idLen, credId, Buffer.from(isoCBOR.encode(cose))]);
      const att = isoCBOR.encode(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
      return { id: b64u(credId), rawId: b64u(credId), type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: b64u(client("webauthn.create", challenge, o)), attestationObject: b64u(Buffer.from(att)), transports: ["internal"] } };
    },
    get(challenge: string, o = origin) {
      counter++;
      const c = Buffer.alloc(4);
      c.writeUInt32BE(counter);
      const authData = Buffer.concat([sha(Buffer.from(rpID)), Buffer.from([0x05]), c]);
      const cd = client("webauthn.get", challenge, o);
      const signature = sign("sha256", Buffer.concat([authData, sha(cd)]), privateKey);
      return { id: b64u(credId), rawId: b64u(credId), type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: b64u(cd), authenticatorData: b64u(authData), signature: b64u(signature) } };
    },
  };
}

async function setup(env: Record<string, string> = {}) {
  const store = new Store(":memory:");
  const app = await buildApp(loadConfig({ WEB_DIR: "./does-not-exist", ...env }), { fetchImpl: fakeEngine(), store });
  const pin = await app.inject({ method: "POST", url: "/api/adult/pin", payload: { pin: "4321" } });
  const cookie = String(pin.headers["set-cookie"]).split(";")[0];
  const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => app.inject({ method: "POST", url, payload: payload as object, headers: { origin: ORIGIN, ...headers } });
  return { app, cookie, post };
}

describe("Face ID (passkey) unlock", () => {
  it("is set up while unlocked, then unlocks 18+ mode without the PIN", async () => {
    const { app, cookie, post } = await setup();
    const p = phone();
    const opts = (await post("/api/adult/passkey/register/options", {}, { cookie })).json();
    const added = await post("/api/adult/passkey/register/verify", { response: p.create(opts.challenge), challenge: opts.challenge, name: "My iPhone" }, { cookie });
    expect(added.statusCode).toBe(200);
    expect(added.json().passkeys.map((x: { name: string }) => x.name)).toEqual(["My iPhone"]);

    await app.inject({ method: "POST", url: "/api/adult/lock", headers: { cookie } });
    expect((await app.inject({ url: "/api/adult" })).json()).toEqual({ pinSet: true, unlocked: false, passkey: true });

    const lo = (await post("/api/adult/passkey/login/options", {})).json();
    expect(lo.allowCredentials).toHaveLength(1);
    const ok = await post("/api/adult/passkey/login/verify", { response: p.get(lo.challenge), challenge: lo.challenge });
    expect(ok.statusCode).toBe(200);
    const fresh = String(ok.headers["set-cookie"]).split(";")[0];
    expect((await app.inject({ url: "/api/adult", headers: { cookie: fresh } })).json().unlocked).toBe(true);

    // A challenge is good once; a replay fails.
    expect((await post("/api/adult/passkey/login/verify", { response: p.get(lo.challenge), challenge: lo.challenge })).statusCode).toBe(403);
  });

  it("refuses a different key, a wrong site, and adding one while locked", async () => {
    const { app, cookie, post } = await setup();
    const p = phone();
    expect((await post("/api/adult/passkey/register/options", {})).statusCode).toBe(403);
    const opts = (await post("/api/adult/passkey/register/options", {}, { cookie })).json();
    await post("/api/adult/passkey/register/verify", { response: p.create(opts.challenge), challenge: opts.challenge }, { cookie });
    await app.inject({ method: "POST", url: "/api/adult/lock", headers: { cookie } });

    const stranger = phone();
    const lo = (await post("/api/adult/passkey/login/options", {})).json();
    const forged = { ...stranger.get(lo.challenge), id: p.get("x").id, rawId: p.get("x").rawId };
    expect((await post("/api/adult/passkey/login/verify", { response: forged, challenge: lo.challenge })).statusCode).toBe(403);

    const lo2 = (await post("/api/adult/passkey/login/options", {})).json();
    expect((await post("/api/adult/passkey/login/verify", { response: p.get(lo2.challenge, "https://evil.example"), challenge: lo2.challenge })).statusCode).toBe(403);
    expect((await app.inject({ url: "/api/adult" })).json().unlocked).toBe(false);
  });

  it("works on the https address even when PUBLIC_URL is still the LAN address", async () => {
    const { cookie, post } = await setup({ PUBLIC_URL: "http://192.168.1.5:8080" });
    const r = await post("/api/adult/passkey/register/options", {}, { cookie });
    expect(r.statusCode).toBe(200);
    expect(r.json().rp.id).toBe(RP);
  });

  it("needs https, and removing a passkey needs 18+ mode on", async () => {
    const { app, cookie, post } = await setup();
    const http = await app.inject({ method: "POST", url: "/api/adult/passkey/register/options", headers: { cookie, origin: "http://192.168.1.5:8080" } });
    expect(http.statusCode).toBe(400);
    const p = phone();
    const opts = (await post("/api/adult/passkey/register/options", {}, { cookie })).json();
    const id = (await post("/api/adult/passkey/register/verify", { response: p.create(opts.challenge), challenge: opts.challenge }, { cookie })).json().passkeys[0].id;
    expect((await app.inject({ method: "DELETE", url: `/api/adult/passkeys/${id}` })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: `/api/adult/passkeys/${id}`, headers: { cookie } })).json().passkeys).toEqual([]);
  });
});
