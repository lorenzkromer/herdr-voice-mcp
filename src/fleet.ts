// Several Herdr instances behind one server (docs/design/multi-instance.md).
//
// Each instance has its own Herdr client and tracker and its own view of the
// config (projects, worktree patterns). The fleet loads all boards in
// parallel, each with a short deadline, and merges them; an instance that does
// not answer is reported instead of failing the call. With a single instance
// everything behaves exactly as before.

import type { AgencyConfig } from "./config.js";
import { HerdrClient, type AgentInfo } from "./herdr.js";
import { assignHandles, loadBoard, normalizeQuery, type AgentView, type Board } from "./projects.js";
import { Tracker } from "./tracker.js";

export interface Instance {
  /** Speakable name, or null for an unnamed single instance. */
  name: string | null;
  /** Config as seen from this instance: its own projects and worktree patterns. */
  cfg: AgencyConfig;
  client: HerdrClient;
  tracker: Tracker;
}

export interface FleetBoard extends Board {
  /** Instances that did not answer in time, with the reason. */
  unreachable: Array<{ instance: string; error: string }>;
}

/** Per-instance deadline for loading the board; keeps tool calls far below the client's ~30 s limit. */
const BOARD_TIMEOUT_MS = 5_000;

/** The config seen from one instance. */
export function instanceConfig(cfg: AgencyConfig, name: string | null, over: Partial<Pick<AgencyConfig, "socket" | "projects" | "worktree_patterns">> = {}): AgencyConfig {
  return { ...cfg, instance_name: name ?? undefined, ...over, instances: [] };
}

export class Fleet {
  /** Wall-clock time of the last delivered stand-up (all instances together). */
  lastStandupAt: Date | null = null;
  /** Config whose `projects` is the union of all instances' projects (local ones win on equal keys), for matching names. */
  readonly cfg: AgencyConfig;

  constructor(
    readonly instances: Instance[],
    baseCfg: AgencyConfig,
  ) {
    if (!instances.length) throw new Error("a fleet needs at least one instance");
    const projects = Object.assign({}, ...[...instances].reverse().map((i) => i.cfg.projects));
    this.cfg = { ...baseCfg, projects };
  }

  get multi(): boolean {
    return this.instances.length > 1;
  }

  /** "Office" or "Office + Home"; null for an unnamed single instance. */
  get label(): string | null {
    const names = this.instances.map((i) => i.name).filter((n): n is string => !!n);
    return names.length ? names.join(" + ") : null;
  }

  byName(name: string | null | undefined): Instance | undefined {
    if (!this.multi && !name) return this.instances[0];
    return this.instances.find((i) => i.name === name) ?? (name == null ? this.instances[0] : undefined);
  }

  /** The instance an agent runs on. */
  of(agent: Pick<AgentView, "instance">): Instance {
    const inst = this.byName(agent.instance);
    if (!inst) throw new Error(`unknown instance "${agent.instance}"`);
    return inst;
  }

  /** The instance named at the start of a target ("Home/shop" or "Home"), if any. */
  prefixOf(target: string): Instance | undefined {
    const slash = target.indexOf("/");
    const head = normalizeQuery(slash >= 0 ? target.slice(0, slash) : target);
    return this.instances.find((i) => i.name && normalizeQuery(i.name) === head);
  }

  /** Loads and merges all boards; keeps each tracker in sync with what it saw. */
  async board(): Promise<FleetBoard> {
    const results = await Promise.all(
      this.instances.map(async (inst) => {
        try {
          const b = await withTimeout(loadBoard(inst.client, inst.cfg), BOARD_TIMEOUT_MS, `no answer within ${BOARD_TIMEOUT_MS / 1000} s`);
          for (const a of b.agents) {
            a.instance = inst.name;
            // Keep the tracker in sync even if its subscription dropped.
            inst.tracker.observe({ pane_id: a.pane_id, agent_status: a.status, state_change_seq: a.state_change_seq } as unknown as AgentInfo);
          }
          return { inst, board: b };
        } catch (e) {
          if (!this.multi) throw e; // a single instance keeps the old behaviour: the tool call fails
          return { inst, error: (e as Error).message };
        }
      }),
    );
    const agents: AgentView[] = [];
    const out: FleetBoard = { agents, workspaces: [], hidden: 0, unreachable: [], instances: this.instances.map((i) => i.name).filter((n): n is string => !!n) };
    for (const r of results) {
      if ("board" in r && r.board) {
        agents.push(...r.board.agents);
        out.workspaces.push(...r.board.workspaces);
        out.hidden += r.board.hidden;
      } else {
        out.unreachable.push({ instance: r.inst.name ?? "?", error: (r as { error: string }).error });
      }
    }
    assignHandles(agents, this.multi);
    return out;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Map key for per-agent state: pane ids repeat across instances. */
export function agentKey(a: Pick<AgentView, "instance" | "pane_id">): string {
  return `${a.instance ?? ""}\u0000${a.pane_id}`;
}

/**
 * Builds the instances described by the config: the local one (top-level instance_name, socket,
 * projects) plus every entry of `instances`. Trackers log with the instance name as prefix.
 */
export function instancesFromConfig(cfg: AgencyConfig, log: (m: string) => void): Instance[] {
  const specs = [
    { name: cfg.instance_name ?? null, socket: cfg.socket, projects: cfg.projects, worktree_patterns: cfg.worktree_patterns },
    ...cfg.instances.map((i) => ({ name: i.name as string | null, socket: i.socket, projects: i.projects, worktree_patterns: i.worktree_patterns })),
  ];
  const multi = specs.length > 1;
  return specs.map((sp) => {
    const client = new HerdrClient(sp.socket);
    const prefix = multi ? `[${sp.name}] ` : "";
    return {
      name: sp.name,
      cfg: instanceConfig(cfg, sp.name, { socket: sp.socket, projects: sp.projects, worktree_patterns: sp.worktree_patterns }),
      client,
      tracker: new Tracker(client, (m) => log(prefix + m)),
    };
  });
}
