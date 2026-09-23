import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { HerdrClient, HerdrError } from "../src/herdr.js";

// A fake Herdr socket: one request per connection, then close; events.subscribe streams.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-"));
const sockPath = path.join(dir, "fake.sock");
let server: net.Server;

before(async () => {
  server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (c) => {
      buf += c.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const req = JSON.parse(buf.slice(0, nl));
      buf = "";
      if (req.method === "ping") {
        sock.end(JSON.stringify({ id: req.id, result: { type: "pong", version: "0.9.0", protocol: 22 } }) + "\n");
      } else if (req.method === "agent.get") {
        sock.end(JSON.stringify({ id: req.id, error: { code: "agent_not_found", message: `agent target ${req.params.target} not found` } }) + "\n");
      } else if (req.method === "events.subscribe") {
        sock.write(JSON.stringify({ id: req.id, result: { type: "subscription_started" } }) + "\n");
        setTimeout(() => sock.write(JSON.stringify({ event: "pane_updated", data: { type: "pane_updated", pane: { pane_id: "w1:p1", agent: "claude", agent_status: "done" } } }) + "\n"), 20);
      } else if (req.method === "slow") {
        /* never answers */
      }
    });
  });
  await new Promise<void>((r) => server.listen(sockPath, r));
});

after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("call returns result", async () => {
  const c = new HerdrClient(sockPath);
  const r = await c.ping();
  assert.equal(r.version, "0.9.0");
});

test("call maps error responses to HerdrError", async () => {
  const c = new HerdrClient(sockPath);
  await assert.rejects(c.agentGet("nope"), (e: unknown) => e instanceof HerdrError && e.code === "agent_not_found");
});

test("call times out", async () => {
  const c = new HerdrClient(sockPath);
  await assert.rejects(c.call("slow", {}, 100), (e: unknown) => e instanceof HerdrError && e.code === "timeout");
});

test("subscribe streams events", async () => {
  const c = new HerdrClient(sockPath);
  const ev = await new Promise<unknown>((resolve) => {
    const stop = c.subscribe([{ type: "pane.updated" }], {
      onEvent: (e) => {
        stop();
        resolve(e.data);
      },
    });
  });
  assert.deepEqual((ev as { pane: { pane_id: string } }).pane.pane_id, "w1:p1");
});
