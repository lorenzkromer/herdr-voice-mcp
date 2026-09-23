#!/usr/bin/env node
// Minimal MCP client for testing a running server.
//
//   node scripts/call-tool.mjs list
//   node scripts/call-tool.mjs status '{"only":"attention"}'
//
// Env: AGENCY_URL (default http://127.0.0.1:<port>/mcp from the config),
//      AGENCY_TOKEN (default auth.token from the config),
//      VIA=path to send the token as a path segment instead of a header.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cfgPath = process.env.AGENCY_CONFIG ?? path.join(os.homedir(), ".config", "agency", "config.json");
const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, "utf8")) : {};
const token = process.env.AGENCY_TOKEN ?? cfg.auth?.token;
const base = process.env.AGENCY_URL ?? `http://127.0.0.1:${cfg.http?.port ?? 8791}${cfg.http?.path ?? "/mcp"}`;
const viaPath = process.env.VIA === "path";
const url = new URL(viaPath ? `${base}/${token}` : base);
const transport = new StreamableHTTPClientTransport(url, viaPath || !token ? {} : { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
const client = new Client({ name: "call-tool", version: "0.0.1" });
await client.connect(transport);

const [tool, argsJson] = process.argv.slice(2);
if (!tool || tool === "list") {
  const t = await client.listTools();
  console.log(t.tools.map((x) => `${x.name}: ${x.description.slice(0, 90)}…`).join("\n"));
} else {
  const r = await client.callTool({ name: tool, arguments: argsJson ? JSON.parse(argsJson) : {} });
  console.log(r.isError ? "[isError]" : "[ok]");
  for (const c of r.content) console.log(c.type === "text" ? c.text : JSON.stringify(c));
}
await client.close();
