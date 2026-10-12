import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

const warmCalls: string[] = [];
const core = createServer((req: IncomingMessage, res) => {
  req.resume();
  req.on("end", () => {
    const u = req.url ?? "";
    if (req.method === "POST" && u.startsWith("/v1/session-cap")) warmCalls.push(u);
    res.setHeader("content-type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify({ token: "cap" }));
  });
});
await new Promise<void>((r) => core.listen(0, r));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_ORG_ID = "acme";
process.env.CORE_SIGNING_SECRET = "page-load-warm-test-secret";
process.env.WEB_UI_PRINCIPALS = "alice";
process.env.ALLOW_UNSIGNED_TEST_IDENTITY = "0";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((r) => surface.listen(0, r));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

test.after(() => {
  surface.close();
  core.close();
});

const until = async (done: () => boolean): Promise<void> => {
  for (let i = 0; i < 50 && !done(); i++) await new Promise((r) => setTimeout(r, 20));
};

test("loading the web UI asks core to warm the user's computer; assets and API calls do not", async () => {
  const headers = {
    [PORTAL_IDENTITY_HEADER]: mintPortalIdentity(
      { p: "alice", exp: Date.now() + 60_000 },
      "page-load-warm-test-secret",
    ),
  };
  await (await fetch(`${base}/assets/missing.js`, { headers })).text();
  await (await fetch(`${base}/me`, { headers })).text();
  assert.deepEqual(
    warmCalls.filter((u) => u.includes("warm=1")),
    [],
  );
  await (await fetch(`${base}/`, { headers })).text();
  await until(() => warmCalls.some((u) => u.includes("warm=1")));
  const warms = warmCalls.filter((u) => u.includes("warm=1"));
  assert.equal(warms.length, 1);
  assert.ok(warms[0]!.startsWith("/v1/session-cap?warm=1"));
});
