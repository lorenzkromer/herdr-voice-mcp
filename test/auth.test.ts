import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { test } from "node:test";
import { authenticate, RateLimiter, tokensEqual } from "../src/auth.js";

const TOKEN = "a".repeat(64);
const req = (authorization?: string) => ({ headers: authorization ? { authorization } : {} }) as unknown as IncomingMessage;
const opts = { token: TOKEN, endpoint: "/mcp", allowTokenInPath: true };

test("bearer header", () => {
  assert.equal(authenticate(req(`Bearer ${TOKEN}`), "/mcp", opts).ok, true);
  assert.equal(authenticate(req(`bearer ${TOKEN}`), "/mcp", opts).ok, true);
  assert.equal(authenticate(req(`Bearer ${"b".repeat(64)}`), "/mcp", opts).ok, false);
  assert.equal(authenticate(req(), "/mcp", opts).ok, false);
});

test("token in path", () => {
  const r = authenticate(req(), `/mcp/${TOKEN}`, opts);
  assert.equal(r.ok, true);
  assert.equal(r.path, "/mcp");
  assert.equal(authenticate(req(), `/mcp/${TOKEN}/extra`, opts).ok, false);
  assert.equal(authenticate(req(), `/mcp/${TOKEN}`, { ...opts, allowTokenInPath: false }).ok, false);
  assert.equal(authenticate(req(), `/other/${TOKEN}`, opts).ok, false);
});

test("tokensEqual handles different lengths", () => {
  assert.equal(tokensEqual("abc", "abcd"), false);
  assert.equal(tokensEqual("abc", "abc"), true);
});

test("rate limiter window", () => {
  const rl = new RateLimiter(3, 1000);
  assert.equal(rl.allow(0), true);
  assert.equal(rl.allow(1), true);
  assert.equal(rl.allow(2), true);
  assert.equal(rl.allow(3), false);
  assert.equal(rl.allow(1001), true);
});
