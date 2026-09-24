import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export const DEFAULT_CONFIG_DIR = path.join(os.homedir(), ".config", "agency");
export const DEFAULT_CONFIG_PATH = path.join(DEFAULT_CONFIG_DIR, "config.json");

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

const ProjectSchema = z.object({
  /** Spoken / display name, e.g. "Acme Web App". */
  name: z.string().min(1),
  /** Absolute path of the primary checkout. Agents whose cwd lies below it belong to the project. */
  root: z.string().min(1),
  /** Additional roots (e.g. non-standard worktree locations). */
  extra_roots: z.array(z.string()).default([]),
  /** Alternative spoken names ("acme", "web app", ...). Matched case-insensitively. */
  aliases: z.array(z.string()).default([]),
  /** Agent kind used by `spawn` when none is given. */
  default_kind: z.string().optional(),
});

const NotifySchema = z.object({
  enabled: z.boolean().default(false),
  /** log = only write to the audit log / stderr (for testing the watcher without a phone). */
  provider: z.enum(["ntfy", "pushover", "log", "none"]).default("none"),
  /** Which transitions trigger a push. */
  on: z.array(z.enum(["done", "blocked"])).default(["done", "blocked"]),
  /** Ignore repeated transitions of the same pane within this window. */
  debounce_seconds: z.number().int().min(0).default(20),
  /** Also show a Herdr toast on the Mac. */
  herdr_toast: z.boolean().default(false),
  ntfy: z
    .object({
      url: z.string().default("https://ntfy.sh"),
      topic: z.string().min(1),
      token: z.string().optional(),
    })
    .optional(),
  pushover: z
    .object({
      user: z.string().min(1),
      token: z.string().min(1),
      device: z.string().optional(),
    })
    .optional(),
});

export const ConfigSchema = z.object({
  /**
   * Speakable name of the Herdr instance this server controls, e.g. "Office". Shown in status,
   * standup and projects, and accepted as a target prefix ("Office/shop/codex"). Optional.
   */
  instance_name: z.string().trim().min(1).max(40).optional(),
  /** Herdr API socket. */
  socket: z.string().default("~/.config/herdr/herdr.sock"),
  http: z
    .object({
      /** One or more addresses to listen on, e.g. ["127.0.0.1", "10.0.0.5"] (localhost for Tailscale Funnel, a VPN address for a reverse proxy). */
      host: z.union([z.string(), z.array(z.string()).min(1)]).default("127.0.0.1"),
      port: z.number().int().min(1).max(65535).default(8791),
      /** URL path of the MCP endpoint. */
      path: z.string().default("/mcp"),
    })
    .prefault({}),
  /** Public base URL of this server as seen by Claude (needed for OAuth resource metadata), e.g. https://agency.example.com */
  public_url: z.string().optional(),
  auth: z
    .object({
      /** token = static bearer token; oauth = Keycloak-issued JWT; both = either is accepted. */
      mode: z.enum(["token", "oauth", "both"]).default("token"),
      /** Static bearer token. Can also come from the AGENCY_TOKEN environment variable. */
      token: z.string().optional(),
      /** Accept the token as the last path segment (`/mcp/<token>`) for clients that cannot send headers. */
      allow_token_in_path: z.boolean().default(true),
      oauth: z
        .object({
          /** OIDC issuer, e.g. https://auth.example.com/realms/main */
          issuer: z.string().url(),
          /** Expected `aud` claim (the Keycloak client id with an audience mapper). Empty = not checked. */
          audience: z.string().optional(),
          /** Only these `preferred_username` values may call tools. Empty = any authenticated user of the realm. */
          allowed_users: z.array(z.string()).default([]),
          /** Required group from the `groups` claim (with or without leading slash). */
          required_group: z.string().optional(),
          /** Scopes advertised in the protected-resource metadata. */
          scopes: z.array(z.string()).default(["openid", "profile"]),
        })
        .optional(),
    })
    .prefault({}),
  /** Whitelisted projects, keyed by a short slug ("acme-web"). Only agents in these projects are visible. */
  projects: z.record(z.string(), ProjectSchema).prefault({}),
  /**
   * Directories holding linked worktrees; `{repo}` is replaced by the basename of the project root.
   * An agent whose cwd lies below such a directory belongs to that project. Herdr's own worktree
   * workspaces are attributed via their repo root automatically and need no pattern.
   */
  worktree_patterns: z.array(z.string()).default([]),
  /** Agent kinds `spawn` may start. */
  agent_kinds: z.array(z.string()).default(["claude", "codex"]),
  rate_limit: z
    .object({
      max_requests: z.number().int().min(1).default(120),
      window_seconds: z.number().int().min(1).default(60),
    })
    .prefault({}),
  audit_log: z.string().default("~/.config/agency/audit.jsonl"),
  /** When this file exists the HTTP server answers 503 to everything. */
  kill_switch: z.string().default("~/.config/agency/disabled"),
  read: z
    .object({
      default_lines: z.number().int().min(1).default(80),
      max_lines: z.number().int().min(1).default(400),
      standup_lines: z.number().int().min(1).default(25),
    })
    .prefault({}),
  send: z
    .object({
      /** After delivery, wait this long for an immediate state (blocked/done/idle) before answering. Keep well below the client's transport timeout. */
      settle_seconds: z.number().int().min(0).max(20).default(3),
      /** Upper bound for the `wait` tool. Claude's connector drops calls that take much longer than ~30 s. */
      max_wait_seconds: z.number().int().min(5).max(60).default(25),
      /** Refuse an identical prompt to the same agent within this window unless force=true. */
      dedupe_minutes: z.number().int().min(0).default(15),
    })
    .prefault({}),
  notify: NotifySchema.prefault({}),
});

export type AgencyConfig = z.infer<typeof ConfigSchema>;
export type ProjectConfig = z.infer<typeof ProjectSchema>;
export type NotifyConfig = z.infer<typeof NotifySchema>;

export interface LoadedConfig extends AgencyConfig {
  configPath: string | null;
}

function normalize(cfg: AgencyConfig): AgencyConfig {
  cfg.socket = expandHome(cfg.socket);
  cfg.audit_log = expandHome(cfg.audit_log);
  cfg.kill_switch = expandHome(cfg.kill_switch);
  cfg.worktree_patterns = cfg.worktree_patterns.map(expandHome);
  for (const p of Object.values(cfg.projects)) {
    p.root = path.resolve(expandHome(p.root));
    p.extra_roots = p.extra_roots.map((r) => path.resolve(expandHome(r)));
  }
  if (!cfg.auth.token && process.env.AGENCY_TOKEN) cfg.auth.token = process.env.AGENCY_TOKEN;
  if (cfg.public_url) cfg.public_url = cfg.public_url.replace(/\/+$/, "");
  if (!cfg.http.path.startsWith("/")) cfg.http.path = "/" + cfg.http.path;
  cfg.http.path = cfg.http.path.replace(/\/+$/, "") || "/mcp";
  return cfg;
}

export function parseConfig(raw: unknown): AgencyConfig {
  return normalize(ConfigSchema.parse(raw ?? {}));
}

/** Resolution order: explicit path → $AGENCY_CONFIG → ~/.config/agency/config.json → ./config.json → defaults. */
export function loadConfig(explicitPath?: string): LoadedConfig {
  const candidates = [
    explicitPath,
    process.env.AGENCY_CONFIG,
    DEFAULT_CONFIG_PATH,
    path.join(process.cwd(), "config.json"),
  ].filter((p): p is string => !!p);

  for (const candidate of candidates) {
    const p = expandHome(candidate);
    if (!fs.existsSync(p)) {
      if (candidate === explicitPath || candidate === process.env.AGENCY_CONFIG) {
        throw new Error(`config file not found: ${p}`);
      }
      continue;
    }
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    return { ...parseConfig(raw), configPath: p };
  }
  return { ...parseConfig({}), configPath: null };
}
