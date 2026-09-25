import assert from "node:assert/strict";
import { test } from "node:test";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { downgradeNewerProtocolVersion } from "../src/protocol.js";

test("a newer protocol version is mapped to the latest supported one", () => {
  const req = { headers: { "mcp-protocol-version": "2026-07-28" } as Record<string, string>, rawHeaders: ["Host", "x", "MCP-Protocol-Version", "2026-07-28"] };
  assert.equal(downgradeNewerProtocolVersion(req), "2026-07-28");
  assert.equal(req.headers["mcp-protocol-version"], LATEST_PROTOCOL_VERSION);
  // The SDK's Node adapter reads rawHeaders; they must change too.
  assert.deepEqual(req.rawHeaders, ["Host", "x", "MCP-Protocol-Version", LATEST_PROTOCOL_VERSION]);
});

test("supported, older, malformed or missing versions are left alone", () => {
  for (const v of [LATEST_PROTOCOL_VERSION, "2025-03-26", "2023-01-01", "latest", "2026-7-28"]) {
    const req = { headers: { "mcp-protocol-version": v } as Record<string, string>, rawHeaders: ["mcp-protocol-version", v] };
    assert.equal(downgradeNewerProtocolVersion(req), null, v);
    assert.deepEqual(req.rawHeaders, ["mcp-protocol-version", v]);
  }
  assert.equal(downgradeNewerProtocolVersion({ headers: {}, rawHeaders: [] }), null);
});
