#!/usr/bin/env node
// Back channel: watches Herdr agent state and pushes "done" / "blocked"
// notifications to the phone. Runs on the Mac, independent of Claude.
//
//   agency-notify              run the watcher
//   agency-notify --test       send one test notification and exit
//   agency-notify --config P   explicit config file

import { Audit } from "./audit.js";
import { loadConfig, type NotifyConfig } from "./config.js";
import { HerdrClient, type AgentInfo, type AgentStatus, type PaneInfo } from "./herdr.js";
import { projectForAgent } from "./projects.js";
import { Tracker } from "./tracker.js";

interface Push {
  title: string;
  body: string;
  priority: "default" | "high";
  tags?: string[];
}

async function sendPush(cfg: NotifyConfig, push: Push): Promise<void> {
  if (cfg.provider === "log") {
    process.stderr.write(`${new Date().toISOString()} PUSH [${push.priority}] ${push.title} — ${push.body}\n`);
    return;
  }
  if (cfg.provider === "ntfy") {
    if (!cfg.ntfy) throw new Error("notify.ntfy is not configured");
    const url = `${cfg.ntfy.url.replace(/\/+$/, "")}/${encodeURIComponent(cfg.ntfy.topic)}`;
    const headers: Record<string, string> = {
      Title: push.title,
      Priority: push.priority === "high" ? "high" : "default",
      Tags: (push.tags ?? []).join(","),
      "Content-Type": "text/plain; charset=utf-8",
    };
    if (cfg.ntfy.token) headers.Authorization = `Bearer ${cfg.ntfy.token}`;
    const r = await fetch(url, { method: "POST", headers, body: push.body });
    if (!r.ok) throw new Error(`ntfy responded ${r.status}: ${await r.text()}`);
    return;
  }
  if (cfg.provider === "pushover") {
    if (!cfg.pushover) throw new Error("notify.pushover is not configured");
    const form = new URLSearchParams({
      token: cfg.pushover.token,
      user: cfg.pushover.user,
      title: push.title,
      message: push.body,
      priority: push.priority === "high" ? "1" : "0",
    });
    if (cfg.pushover.device) form.set("device", cfg.pushover.device);
    const r = await fetch("https://api.pushover.net/1/messages.json", { method: "POST", body: form });
    if (!r.ok) throw new Error(`pushover responded ${r.status}: ${await r.text()}`);
    return;
  }
  throw new Error(`notify.provider is "${cfg.provider}" – nothing sent`);
}

function parseArgs(argv: string[]) {
  const out: { test: boolean; config?: string } = { test: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--test") out.test = true;
    else if (argv[i] === "--config") out.config = argv[++i];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig(args.config);
  const log = (m: string) => process.stderr.write(`${new Date().toISOString()} ${m}\n`);
  const audit = new Audit(cfg.audit_log, log);
  const n = cfg.notify;

  if (args.test) {
    await sendPush(n, { title: "agency: test", body: "The notification channel works.", priority: "default", tags: ["white_check_mark"] });
    log("test notification sent");
    return;
  }
  if (!n.enabled || n.provider === "none") {
    log("notify.enabled is false or provider is none – nothing to do. Set it in the config and restart.");
    process.exit(1);
  }

  const client = new HerdrClient(cfg.socket);
  const tracker = new Tracker(client, log);
  const lastSent = new Map<string, number>();
  let workspaceCache: Awaited<ReturnType<HerdrClient["workspaceList"]>> = [];
  let workspaceCacheAt = 0;

  const workspaces = async () => {
    if (Date.now() - workspaceCacheAt > 30_000) {
      try {
        workspaceCache = await client.workspaceList();
        workspaceCacheAt = Date.now();
      } catch (e) {
        log(`workspace.list failed: ${(e as Error).message}`);
      }
    }
    return workspaceCache;
  };

  tracker.onTransition(async (pane_id, from, to, pane) => {
    if (!n.on.includes(to as "done" | "blocked")) return;
    const wsList = await workspaces();
    const ws = wsList.find((w) => w.workspace_id === pane.workspace_id) ?? null;
    const projectKey = projectForAgent(cfg, pane as AgentInfo | PaneInfo, ws);
    if (!projectKey) return; // outside the whitelist
    const now = Date.now();
    const last = lastSent.get(pane_id) ?? 0;
    if (now - last < n.debounce_seconds * 1000) return;
    lastSent.set(pane_id, now);

    const project = cfg.projects[projectKey].name;
    const name = (pane as AgentInfo).name ?? ws?.label ?? pane_id;
    const topic = (pane as AgentInfo).terminal_title_stripped ?? (pane as PaneInfo).title ?? null;
    const push: Push =
      to === "blocked"
        ? { title: `${project}: decision needed`, body: `${name} is waiting for an answer${topic ? ` – ${topic}` : ""}.`, priority: "high", tags: ["question"] }
        : { title: `${project}: finished`, body: `${name} is done${topic ? ` – ${topic}` : ""}. Ask Claude: "What's new?"`, priority: "default", tags: ["white_check_mark"] };
    try {
      await sendPush(n, push);
      if (n.herdr_toast) await client.notificationShow(push.title, push.body, to === "blocked" ? "request" : "done").catch(() => {});
      audit.record({ kind: "notify", name: to as AgentStatus, outcome: "ok", detail: `${project}/${name} ${from ?? "?"}→${to}` });
    } catch (e) {
      audit.record({ kind: "notify", name: to as AgentStatus, outcome: "error", error: (e as Error).message });
    }
  });

  await tracker.start();
  log(`agency-notify watching (${n.provider}; on: ${n.on.join(", ")}; projects: ${Object.keys(cfg.projects).join(", ") || "none"})`);
  const stop = () => {
    tracker.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  process.stderr.write(`fatal: ${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
