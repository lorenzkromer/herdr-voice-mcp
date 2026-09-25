#!/usr/bin/env node
// MCP server "agency".
//
//   agency-mcp                 HTTP (Streamable HTTP transport), bound to config.http
//   agency-mcp --stdio         stdio transport for local Claude Code (no auth needed)
//   agency-mcp --config PATH   explicit config file
//
// HTTP request flow: kill switch → auth (static token and/or Keycloak JWT) →
// rate limit → per-request McpServer + stateless StreamableHTTPServerTransport.

import http from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Audit } from "./audit.js";
import { authenticate, killSwitchOn, RateLimiter } from "./auth.js";
import { loadConfig, type LoadedConfig } from "./config.js";
import { Fleet, instancesFromConfig } from "./fleet.js";
import { OAuthVerifier, protectedResourceMetadata } from "./oauth.js";
import { downgradeNewerProtocolVersion } from "./protocol.js";
import { ReadApi } from "./readapi.js";
import { createMcpServer } from "./tools.js";

function parseArgs(argv: string[]) {
  const out: { stdio: boolean; config?: string; help: boolean } = { stdio: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--stdio") out.stdio = true;
    else if (a === "--config") out.config = argv[++i];
    else if (a === "-h" || a === "--help") out.help = true;
  }
  return out;
}

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write("usage: agency-mcp [--stdio] [--config PATH]\n");
    return;
  }
  const cfg: LoadedConfig = loadConfig(args.config);
  const log = (m: string) => process.stderr.write(`${new Date().toISOString()} ${m}\n`);
  const audit = new Audit(cfg.audit_log, log);
  const instances = instancesFromConfig(cfg, log);
  const fleet = new Fleet(instances, cfg);
  for (const inst of instances) {
    const who = inst.name ? `${inst.name}: ` : "";
    try {
      const p = await inst.client.ping();
      log(`${who}herdr ${p.version} (protocol ${p.protocol}) at ${inst.client.socketPath}`);
    } catch (e) {
      log(`WARNING: ${who}Herdr not reachable at ${inst.client.socketPath}: ${(e as Error).message}. ${fleet.multi ? "It is reported as unreachable" : "Tools will fail"} until it is.`);
    }
    await inst.tracker.start();
  }
  audit.record({ kind: "system", name: "start", outcome: "ok", detail: `config=${cfg.configPath ?? "defaults"} projects=${Object.keys(cfg.projects).length} instances=${instances.length} mode=${args.stdio ? "stdio" : "http"}` });

  if (!Object.keys(cfg.projects).length) log("WARNING: no projects configured – every agent is hidden by the whitelist.");

  if (args.stdio) {
    const server = createMcpServer({ cfg, fleet, audit, source: "stdio" });
    await server.connect(new StdioServerTransport());
    return;
  }

  // ---------------------------------------------------------------- HTTP
  const mode = cfg.auth.mode;
  const token = cfg.auth.token;
  const oauthCfg = cfg.auth.oauth;
  if ((mode === "token" || mode === "both") && (!token || token.length < 32)) {
    throw new Error("auth.token (or AGENCY_TOKEN) must be set and at least 32 characters long for HTTP mode");
  }
  if ((mode === "oauth" || mode === "both") && !oauthCfg) {
    throw new Error("auth.oauth must be configured when auth.mode is oauth or both");
  }
  const verifier = oauthCfg ? new OAuthVerifier({ issuer: oauthCfg.issuer, audience: oauthCfg.audience, allowedUsers: oauthCfg.allowed_users, requiredGroup: oauthCfg.required_group }) : null;
  const limiter = new RateLimiter(cfg.rate_limit.max_requests, cfg.rate_limit.window_seconds * 1000);
  const endpoint = cfg.http.path;
  const hosts = Array.isArray(cfg.http.host) ? cfg.http.host : [cfg.http.host];
  const publicUrl = cfg.public_url ?? `http://${hosts[0]}:${cfg.http.port}`;
  // OAuth discovery is only advertised on the public OAuth hostname (e.g. agency.example.com).
  // Other routes (Tailscale Funnel with token-in-path) must look like plain token endpoints,
  // otherwise the Claude connector switches to an OAuth flow it cannot complete there.
  const oauthHost = cfg.public_url ? new URL(cfg.public_url).host.toLowerCase() : null;
  const metadataPath = "/.well-known/oauth-protected-resource";
  const isOAuthHost = (req: http.IncomingMessage) => !!oauthCfg && !!oauthHost && (req.headers.host ?? "").toLowerCase() === oauthHost;
  const wwwAuth = (req: http.IncomingMessage) => {
    if (!isOAuthHost(req)) return 'Bearer realm="agency"';
    return `Bearer realm="agency", resource_metadata="${publicUrl}${metadataPath}"`;
  };

  const readApi = cfg.read_api.enabled ? new ReadApi(cfg, fleet, audit) : null;
  if (readApi) log(`read API: ${cfg.read_api.path}/agents (+ /stream), ${cfg.read_api.tokens.length} token(s), origins: ${cfg.read_api.allowed_origins.join(", ") || "none (no browser access)"}`);

  /** Newer protocol versions already reported in the log (once each). */
  const seenNewerVersions = new Set<string>();
  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const source = `${(req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? "?"}`;
    // One access-log line per request; a token in the path is masked.
    const t0 = Date.now();
    const shownPath = token ? url.pathname.replace(token, "<token>") : url.pathname;
    // Why a request was rejected (set by the MCP transport's onerror); logged with the access line.
    let rejection: string | null = null;
    res.on("finish", () => {
      const pv = req.headers["mcp-protocol-version"];
      const extra = res.statusCode >= 400 ? `${pv ? ` protocol="${pv}"` : ""}${rejection ? ` reason="${rejection}"` : ""}` : "";
      log(`${source} ${req.method} ${shownPath} → ${res.statusCode} ${Date.now() - t0}ms ua="${req.headers["user-agent"] ?? ""}" accept="${req.headers.accept ?? ""}"${extra}`);
    });

    if (killSwitchOn(cfg.kill_switch)) {
      audit.record({ kind: "http", name: url.pathname, source, outcome: "denied", error: "kill switch" });
      json(res, 503, { error: "agency is switched off" });
      return;
    }

    // Read-only API for dashboards: own tokens (header only), own CORS rules.
    if (readApi?.matches(url.pathname)) {
      if (!limiter.allow()) {
        json(res, 429, { error: "too many requests" }, { "retry-after": String(cfg.rate_limit.window_seconds) });
        return;
      }
      await readApi.handle(req, res, url, source);
      return;
    }

    // Public discovery documents (no secrets inside).
    if (req.method === "GET" && (url.pathname === metadataPath || url.pathname === `${metadataPath}${endpoint}`)) {
      if (!oauthCfg || !isOAuthHost(req)) {
        json(res, 404, { error: "not found" });
        return;
      }
      json(res, 200, protectedResourceMetadata(publicUrl, endpoint, oauthCfg.issuer, oauthCfg.scopes));
      return;
    }

    // Anything that is not the MCP endpoint is 404, without an auth challenge. Discovery
    // probes (/.well-known/oauth-authorization-server etc.) must not see a 401, otherwise
    // clients assume OAuth is required and give up.
    if ((url.pathname !== endpoint && !url.pathname.startsWith(endpoint + "/")) || url.pathname.includes("/.well-known/")) {
      json(res, 404, { error: "not found" });
      return;
    }

    // ---- authentication
    let who: string | null = null;
    let pathname = url.pathname;
    const header = req.headers.authorization;
    if ((mode === "token" || mode === "both") && token) {
      const r = authenticate(req, url.pathname, { token, endpoint, allowTokenInPath: cfg.auth.allow_token_in_path });
      if (r.ok) {
        who = `token:${r.via}`;
        pathname = r.path;
      }
    }
    if (!who && verifier && typeof header === "string" && /^Bearer\s+/i.test(header)) {
      const raw = header.replace(/^Bearer\s+/i, "").trim();
      // Static tokens are hex; JWTs have two dots. Only try JWT verification on JWT-shaped input.
      if (raw.split(".").length === 3) {
        try {
          const id = await verifier.verify(raw);
          who = `oauth:${id.username ?? id.subject}`;
        } catch (e) {
          audit.record({ kind: "http", name: url.pathname, source, outcome: "denied", error: `oauth: ${(e as Error).message}` });
          json(res, 401, { error: "invalid_token", error_description: (e as Error).message }, { "www-authenticate": `${wwwAuth(req)}, error="invalid_token"` });
          return;
        }
      }
    }
    if (!who) {
      audit.record({ kind: "http", name: url.pathname, source, outcome: "denied", error: "unauthorized" });
      json(res, 401, { error: "unauthorized" }, { "www-authenticate": wwwAuth(req) });
      return;
    }

    if (pathname.replace(/\/+$/, "") !== endpoint) {
      json(res, 404, { error: "not found" });
      return;
    }
    if (!limiter.allow()) {
      audit.record({ kind: "http", name: endpoint, source, outcome: "denied", error: "rate limit" });
      json(res, 429, { error: "too many requests" }, { "retry-after": String(cfg.rate_limit.window_seconds) });
      return;
    }
    if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
      json(res, 405, { error: "method not allowed" });
      return;
    }

    const newer = downgradeNewerProtocolVersion(req);
    if (newer && !seenNewerVersions.has(newer)) {
      seenNewerVersions.add(newer);
      log(`client speaks MCP protocol ${newer}, newer than this SDK supports; answering as ${req.headers["mcp-protocol-version"]}`);
    }
    const mcp = createMcpServer({ cfg, fleet, audit, source: `${source} ${who}` });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    // The SDK answers malformed or unsupported requests with 400 itself; without this the reason is lost.
    transport.onerror = (e) => {
      rejection = e.message;
      audit.record({ kind: "http", name: endpoint, source, outcome: "error", error: `mcp transport: ${e.message}` });
    };
    res.on("close", () => {
      transport.close().catch(() => {});
      mcp.close().catch(() => {});
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      log(`request failed: ${(e as Error).message}`);
      if (!res.headersSent) json(res, 500, { error: "internal error" });
    }
  };

  // One listener per configured address (localhost for Funnel, WireGuard address for Traefik).
  const servers = hosts.map((host) => {
    const server = http.createServer(handle);
    server.on("error", (e: NodeJS.ErrnoException) => {
      const hint = e.code === "EADDRINUSE" ? "port already in use – change http.port in the config" : e.code === "EADDRNOTAVAIL" ? "address not available – is the tunnel up?" : e.message;
      log(`cannot listen on ${host}:${cfg.http.port}: ${hint}`);
      process.exit(1);
    });
    server.listen(cfg.http.port, host, () => log(`agency MCP listening on http://${host}:${cfg.http.port}${endpoint}`));
    return server;
  });
  log(`auth: ${mode}${oauthCfg ? `, issuer ${oauthCfg.issuer}, oauth host ${oauthHost}` : ""}`);
  if (cfg.public_url) log(`public URL: ${cfg.public_url}${endpoint}`);
  log(`kill switch: touch ${cfg.kill_switch}`);

  const shutdown = () => {
    audit.record({ kind: "system", name: "stop", outcome: "ok" });
    readApi?.close();
    for (const inst of instances) inst.tracker.close();
    for (const s of servers) s.close();
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  process.stderr.write(`fatal: ${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
