// MCP protocol version header handling.
//
// The SDK rejects any request whose `MCP-Protocol-Version` header it does not
// know with HTTP 400. Clients that already speak a newer revision (the Claude
// app sent "2026-07-28" while the SDK knew up to "2025-11-25") then fail their
// first attempt and only succeed on a retry with an older version. A newer,
// unknown version is therefore mapped to the newest one the SDK supports; the
// tools this server offers do not depend on the difference. Older or malformed
// versions are left alone, so the SDK still rejects them.

import type { IncomingHttpHeaders } from "node:http";
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";

const VERSION_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Rewrites a newer-than-supported protocol version header in place, in both `headers` and
 * `rawHeaders` (the SDK's Node adapter builds its Request from `rawHeaders`).
 * Returns the original version when it was rewritten, otherwise null.
 */
export function downgradeNewerProtocolVersion(req: { headers: IncomingHttpHeaders; rawHeaders: string[] }): string | null {
  const v = req.headers["mcp-protocol-version"];
  if (typeof v !== "string" || SUPPORTED_PROTOCOL_VERSIONS.includes(v)) return null;
  if (!VERSION_RE.test(v) || v <= LATEST_PROTOCOL_VERSION) return null;
  req.headers["mcp-protocol-version"] = LATEST_PROTOCOL_VERSION;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === "mcp-protocol-version") req.rawHeaders[i + 1] = LATEST_PROTOCOL_VERSION;
  }
  return v;
}
