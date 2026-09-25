// Minimal client for the Herdr socket API.
//
// Wire format (verified against herdr 0.9.0, protocol 22):
//   - Unix domain socket, newline-delimited JSON.
//   - Request:  {"id": "<string>", "method": "<name>", "params": {...}}\n
//   - Response: {"id": "...", "result": {...}}  or  {"id": "...", "error": {"code", "message"}}
//   - The server closes the connection after one request/response pair,
//     except for `events.subscribe`, which keeps streaming
//     {"event": "<kind>", "data": {...}} envelopes on the same connection.

import net from "node:net";
import { randomUUID } from "node:crypto";

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface AgentSessionInfo {
  agent: string;
  kind: string;
  source: string;
  value: string;
}

export interface AgentInfo {
  terminal_id: string;
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  agent: string | null;
  display_agent?: string | null;
  name?: string | null;
  agent_status: AgentStatus;
  agent_session?: AgentSessionInfo | null;
  cwd?: string | null;
  foreground_cwd?: string | null;
  focused: boolean;
  revision: number;
  state_change_seq?: number;
  state_labels?: Record<string, string>;
  title?: string | null;
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
  tokens?: Record<string, string>;
  interactive_ready?: boolean;
  launch_pending?: boolean;
}

export interface PaneInfo {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  agent: string | null;
  agent_status: AgentStatus;
  cwd?: string | null;
  label?: string | null;
  title?: string | null;
  focused: boolean;
  revision: number;
}

export interface WorkspaceWorktreeInfo {
  repo_key: string;
  repo_name: string;
  repo_root: string;
  checkout_path: string;
  is_linked_worktree: boolean;
}

export interface WorkspaceInfo {
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  tab_count: number;
  active_tab_id: string;
  agent_status: AgentStatus;
  worktree?: WorkspaceWorktreeInfo | null;
}

export interface TabInfo {
  tab_id: string;
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  agent_status: AgentStatus;
}

export interface PaneReadResult {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  source: string;
  format: string;
  text: string;
  revision: number;
  truncated: boolean;
}

export interface HerdrEvent {
  event: string;
  data: Record<string, unknown> & { type: string };
}

export type ReadSource = "visible" | "recent" | "recent_unwrapped" | "detection";

export class HerdrError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HerdrError";
    this.code = code;
  }
}

export interface Subscription {
  type: string;
  [key: string]: unknown;
}

export interface SubscriptionHandlers {
  onEvent: (event: HerdrEvent) => void;
  onOpen?: () => void;
  onClose?: (error?: Error) => void;
}

export class HerdrClient {
  constructor(readonly socketPath: string) {}

  /** One request, one connection. Resolves with `result`, rejects with HerdrError. */
  call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = randomUUID();
      const sock = net.createConnection(this.socketPath);
      let buf = "";
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.destroy();
        fn();
      };
      const timer = setTimeout(
        () => finish(() => reject(new HerdrError("timeout", `${method}: no response after ${timeoutMs} ms`))),
        timeoutMs,
      );

      sock.setEncoding("utf8");
      sock.on("connect", () => {
        sock.write(JSON.stringify({ id, method, params }) + "\n");
      });
      sock.on("data", (chunk: string) => {
        buf += chunk;
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        let msg: { id?: string; result?: T; error?: { code: string; message: string } };
        try {
          msg = JSON.parse(line);
        } catch (e) {
          finish(() => reject(new HerdrError("bad_response", `${method}: unparsable response: ${(e as Error).message}`)));
          return;
        }
        if (msg.error) {
          const err = msg.error;
          finish(() => reject(new HerdrError(err.code, err.message)));
        } else {
          finish(() => resolve(msg.result as T));
        }
      });
      sock.on("error", (e) => finish(() => reject(new HerdrError("socket_error", `${method}: ${e.message}`))));
      sock.on("close", () => finish(() => reject(new HerdrError("connection_closed", `${method}: connection closed without response`))));
    });
  }

  /**
   * Long-lived subscription. Returns a function that closes it.
   * The caller is responsible for reconnecting when `onClose` fires.
   */
  subscribe(subscriptions: Subscription[], handlers: SubscriptionHandlers): () => void {
    const id = randomUUID();
    const sock = net.createConnection(this.socketPath);
    let buf = "";
    let started = false;
    let closed = false;

    const close = (err?: Error) => {
      if (closed) return;
      closed = true;
      sock.destroy();
      handlers.onClose?.(err);
    };

    sock.setEncoding("utf8");
    sock.on("connect", () => {
      sock.write(JSON.stringify({ id, method: "events.subscribe", params: { subscriptions } }) + "\n");
    });
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (!started) {
          if (msg.error) {
            const e = msg.error as { code: string; message: string };
            close(new HerdrError(e.code, e.message));
            return;
          }
          started = true;
          handlers.onOpen?.();
          continue;
        }
        if (typeof msg.event === "string" && msg.data && typeof msg.data === "object") {
          handlers.onEvent(msg as unknown as HerdrEvent);
        }
      }
    });
    sock.on("error", (e) => close(new HerdrError("socket_error", e.message)));
    sock.on("close", () => close());
    return () => close();
  }

  // ---- typed helpers -------------------------------------------------

  async ping(): Promise<{ version: string; protocol: number }> {
    return this.call("ping", {});
  }

  async agentList(): Promise<AgentInfo[]> {
    const r = await this.call<{ agents: AgentInfo[] }>("agent.list", {});
    return r.agents;
  }

  async agentGet(target: string): Promise<AgentInfo> {
    const r = await this.call<{ agent: AgentInfo }>("agent.get", { target });
    return r.agent;
  }

  async agentRead(target: string, lines: number, source: ReadSource = "recent_unwrapped"): Promise<PaneReadResult> {
    const r = await this.call<{ read: PaneReadResult }>("agent.read", { target, source, lines, format: "text", strip_ansi: true });
    return r.read;
  }

  async paneRead(pane_id: string, lines: number, source: ReadSource = "recent_unwrapped"): Promise<PaneReadResult> {
    const r = await this.call<{ read: PaneReadResult }>("pane.read", { pane_id, source, lines, format: "text", strip_ansi: true });
    return r.read;
  }

  async agentPrompt(
    target: string,
    text: string,
    wait?: { until?: AgentStatus[]; timeout_ms?: number },
    socketTimeoutMs = 20_000,
  ): Promise<AgentInfo> {
    const params: Record<string, unknown> = { target, text };
    let socketTimeout = socketTimeoutMs;
    if (wait) {
      params.wait = { until: wait.until ?? [], timeout_ms: wait.timeout_ms ?? null };
      socketTimeout = (wait.timeout_ms ?? 600_000) + 10_000;
    }
    const r = await this.call<{ agent: AgentInfo }>("agent.prompt", params, socketTimeout);
    return r.agent;
  }

  async agentWait(target: string, until: AgentStatus[], timeout_ms: number): Promise<AgentInfo> {
    const r = await this.call<{ agent: AgentInfo }>("agent.wait", { target, until, timeout_ms }, timeout_ms + 10_000);
    return r.agent;
  }

  async agentSendKeys(target: string, keys: string[]): Promise<void> {
    await this.call("agent.send_keys", { target, keys });
  }

  async agentStart(name: string, kind: string, pane_id: string, timeout_ms = 60_000, args: string[] = []): Promise<AgentInfo> {
    const r = await this.call<{ agent: AgentInfo }>("agent.start", { name, kind, pane_id, timeout_ms, args }, timeout_ms + 10_000);
    return r.agent;
  }

  async agentFocus(target: string): Promise<void> {
    await this.call("agent.focus", { target });
  }

  async workspaceList(): Promise<WorkspaceInfo[]> {
    const r = await this.call<{ workspaces: WorkspaceInfo[] }>("workspace.list", {});
    return r.workspaces;
  }

  async workspaceCreate(label: string, cwd: string): Promise<{ workspace: WorkspaceInfo; tab: TabInfo; root_pane: PaneInfo }> {
    return this.call("workspace.create", { label, cwd, focus: false });
  }

  /**
   * Creates a Git worktree (new branch, own checkout) and opens it as a workspace that Herdr
   * groups under the repository's primary workspace. Pass the primary `workspace_id`, or a
   * `cwd` inside the repository.
   */
  async worktreeCreate(opts: { workspace_id?: string; cwd?: string; branch: string; label?: string; base?: string }, timeoutMs = 30_000): Promise<{ workspace: WorkspaceInfo; tab: TabInfo; root_pane: PaneInfo; worktree: { path: string; branch: string } }> {
    return this.call("worktree.create", { ...opts, focus: false }, timeoutMs);
  }

  async workspaceClose(workspace_id: string): Promise<void> {
    await this.call("workspace.close", { workspace_id });
  }

  async tabList(workspace_id?: string): Promise<TabInfo[]> {
    const r = await this.call<{ tabs: TabInfo[] }>("tab.list", { workspace_id: workspace_id ?? null });
    return r.tabs;
  }

  async tabCreate(workspace_id: string, cwd: string, label?: string): Promise<{ tab: TabInfo; root_pane: PaneInfo }> {
    return this.call("tab.create", { workspace_id, cwd, label: label ?? null, focus: false });
  }

  async tabClose(tab_id: string): Promise<void> {
    await this.call("tab.close", { tab_id });
  }

  async paneList(workspace_id?: string): Promise<PaneInfo[]> {
    const r = await this.call<{ panes: PaneInfo[] }>("pane.list", { workspace_id: workspace_id ?? null });
    return r.panes;
  }

  async notificationShow(title: string, body?: string, sound: "none" | "done" | "request" = "none"): Promise<void> {
    await this.call("notification.show", { title, body: body ?? null, sound });
  }
}
