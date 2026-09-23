// Tracks *when* each agent last changed state. Herdr exposes a monotonic
// `state_change_seq` but no timestamp, so we watch events and remember the
// wall-clock time of every observed transition.
//
// Verified against herdr 0.9.0: `pane.updated` does NOT fire for every status
// change (e.g. working → done is missing), but `pane.agent_status_changed`
// does – and that subscription needs one entry per pane. So the tracker keeps
// a per-pane subscription list and re-subscribes whenever agents come or go.

import type { AgentInfo, AgentStatus, HerdrClient, HerdrEvent, PaneInfo } from "./herdr.js";

export interface TrackedState {
  status: AgentStatus;
  since: Date;
  seq: number;
  previous: AgentStatus | null;
}

export type TransitionListener = (pane_id: string, from: AgentStatus | null, to: AgentStatus, pane: PaneInfo | AgentInfo) => void;

const RESEED_INTERVAL_MS = 60_000;

export class Tracker {
  private states = new Map<string, TrackedState>();
  private meta = new Map<string, AgentInfo>();
  private listeners: TransitionListener[] = [];
  private stop: (() => void) | null = null;
  private stopped = false;
  private backoffMs = 1000;
  private subscribedPanes: string[] = [];
  private resubscribing = false;
  private timer: NodeJS.Timeout | null = null;
  /** Wall-clock time of the last standup that was delivered; used to mark "new since last standup". */
  lastStandupAt: Date | null = null;
  /** True once the first agent list has been seeded. */
  ready = false;

  constructor(
    private readonly client: HerdrClient,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  onTransition(fn: TransitionListener): void {
    this.listeners.push(fn);
  }

  get(pane_id: string): TrackedState | undefined {
    return this.states.get(pane_id);
  }

  /** Feed an observation; records a transition when the status differs. */
  observe(pane: PaneInfo | AgentInfo, seedOnly = false): void {
    const now = new Date();
    const seq = (pane as AgentInfo).state_change_seq ?? 0;
    const prev = this.states.get(pane.pane_id);
    // Merge, never replace: pane_updated payloads carry no `name`/`terminal_title` and must not wipe them.
    if ((pane as AgentInfo).terminal_id) this.meta.set(pane.pane_id, { ...(this.meta.get(pane.pane_id) ?? {}), ...pane } as AgentInfo);
    if (!prev) {
      // First sight: we do not know when the agent entered this state, so "now" is a lower bound.
      // During seeding nothing is reported (avoids a burst on startup); afterwards a new agent that
      // is already blocked/done is a real event (e.g. a trust prompt right after spawn).
      this.states.set(pane.pane_id, { status: pane.agent_status, since: now, seq, previous: null });
      if (!seedOnly && this.ready) this.emit(pane.pane_id, null, pane.agent_status, pane);
      return;
    }
    if (prev.status !== pane.agent_status) {
      const from = prev.status;
      this.states.set(pane.pane_id, { status: pane.agent_status, since: now, seq, previous: from });
      if (!seedOnly) this.emit(pane.pane_id, from, pane.agent_status, pane);
    } else if (seq > prev.seq) {
      prev.seq = seq;
    }
  }

  private emit(pane_id: string, from: AgentStatus | null, to: AgentStatus, pane: PaneInfo | AgentInfo): void {
    const full = { ...(this.meta.get(pane_id) ?? {}), ...pane } as PaneInfo | AgentInfo;
    for (const l of this.listeners) {
      try {
        l(pane_id, from, to, full);
      } catch (e) {
        this.log(`tracker: listener failed: ${(e as Error).message}`);
      }
    }
  }

  forget(pane_id: string): void {
    this.states.delete(pane_id);
    this.meta.delete(pane_id);
  }

  /** Refreshes from agent.list. Returns true when the set of agent panes changed. */
  async seed(): Promise<boolean> {
    const agents = await this.client.agentList();
    const live = new Set(agents.map((a) => a.pane_id));
    const before = [...this.states.keys()].sort().join(",");
    for (const a of agents) this.observe(a, !this.ready);
    for (const id of [...this.states.keys()]) if (!live.has(id)) this.forget(id);
    this.ready = true;
    const after = [...this.states.keys()].sort().join(",");
    return before !== after;
  }

  /** Seeds from agent.list and keeps a subscription open (reconnects with backoff). */
  async start(): Promise<void> {
    this.stopped = false;
    try {
      await this.seed();
    } catch (e) {
      this.log(`tracker: initial seed failed: ${(e as Error).message}`);
    }
    this.connect();
    this.timer = setInterval(() => {
      this.seed()
        .then((changed) => {
          if (changed || this.panesDiffer()) this.resubscribe();
        })
        .catch((e) => this.log(`tracker: periodic seed failed: ${(e as Error).message}`));
    }, RESEED_INTERVAL_MS);
    this.timer.unref();
  }

  private panesDiffer(): boolean {
    const want = [...this.states.keys()].sort();
    return want.join(",") !== this.subscribedPanes.join(",");
  }

  private resubscribe(): void {
    if (this.stopped || this.resubscribing) return;
    this.resubscribing = true;
    const old = this.stop;
    this.stop = null;
    old?.();
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;
    this.subscribedPanes = [...this.states.keys()].sort();
    const subs: Array<Record<string, unknown>> = [
      { type: "pane.updated" },
      { type: "pane.closed" },
      { type: "pane.exited" },
      { type: "pane.agent_detected" },
      ...this.subscribedPanes.map((pane_id) => ({ type: "pane.agent_status_changed", pane_id })),
    ];
    let mine: (() => void) | null = null;
    mine = this.client.subscribe(subs as never, {
      onOpen: () => {
        this.backoffMs = 1000;
        this.resubscribing = false;
        this.log(`tracker: subscribed (${this.subscribedPanes.length} agent panes)`);
        // Re-seed after (re)connect so we do not miss transitions during the gap.
        this.seed()
          .then((changed) => {
            if (changed || this.panesDiffer()) this.resubscribe();
          })
          .catch((e) => this.log(`tracker: reseed failed: ${(e as Error).message}`));
      },
      onEvent: (ev) => this.handle(ev),
      onClose: (err) => {
        if (this.stopped) return;
        if (this.stop !== mine) {
          // Closed deliberately by resubscribe(); the replacement is already connecting.
          this.resubscribing = false;
          return;
        }
        this.log(`tracker: subscription closed${err ? `: ${err.message}` : ""}; reconnecting in ${this.backoffMs} ms`);
        this.stop = null;
        setTimeout(() => this.connect(), this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
      },
    });
    this.stop = mine;
  }

  private handle(ev: HerdrEvent): void {
    const d = ev.data;
    const kind = String(d.type ?? ev.event).replace(/\./g, "_");
    switch (kind) {
      case "pane_agent_status_changed": {
        const pane_id = d.pane_id as string;
        const known = this.states.has(pane_id);
        this.observe({
          pane_id,
          workspace_id: d.workspace_id as string,
          agent: (d.agent as string | null) ?? null,
          agent_status: d.agent_status as AgentStatus,
          title: (d.title as string | null) ?? null,
        } as PaneInfo);
        if (!known) this.resubscribe();
        break;
      }
      case "pane_updated": {
        const pane = d.pane as PaneInfo;
        // Only panes with a recognized agent matter. A pane_updated with agent=null is not
        // proof that the agent is gone (detection can flicker mid-turn); removal is driven by
        // pane_closed / pane_exited / agent released and the periodic re-seed.
        if (pane.agent) {
          const known = this.states.has(pane.pane_id);
          this.observe(pane);
          if (!known) this.resubscribe();
        }
        break;
      }
      case "pane_agent_detected": {
        const pane_id = d.pane_id as string;
        if (d.released === true) {
          this.forget(pane_id);
        } else if (!this.states.has(pane_id)) {
          // A new agent appeared: learn its state and start listening to its status changes.
          this.seed()
            .then(() => this.resubscribe())
            .catch((e) => this.log(`tracker: seed after detect failed: ${(e as Error).message}`));
        }
        break;
      }
      case "pane_closed":
      case "pane_exited":
        this.forget(d.pane_id as string);
        break;
      default:
        break;
    }
  }

  close(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.stop?.();
    this.stop = null;
  }
}
