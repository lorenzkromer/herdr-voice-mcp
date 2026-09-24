// Tracks *when* each agent last changed state. Herdr exposes a monotonic
// `state_change_seq` but no timestamp, so we watch events and remember the
// wall-clock time of every observed transition.
//
// Verified against herdr 0.9.0: `pane.updated` does NOT fire for every status
// change (e.g. working → done is missing), but `pane.agent_status_changed`
// does – and that subscription needs one entry per pane. So the tracker keeps
// a per-pane subscription list and re-subscribes whenever agents come or go.
//
// `state_change_seq` is a Herdr-wide counter stamped on a pane at each of its
// state changes. A pane whose seq moved while its status looks unchanged went
// through transitions we did not see (e.g. done → working → done between two
// polls); that counts as a change, too. When polling notices changes the event
// stream should have delivered, the subscription is considered stale and is
// rebuilt (heartbeat).

import type { AgentInfo, AgentStatus, HerdrClient, HerdrEvent, PaneInfo } from "./herdr.js";

export interface TrackedState {
  status: AgentStatus;
  /** When the current state began. For states first seen at startup this is only a lower bound. */
  since: Date;
  /** Last known `state_change_seq`; null after an event-driven change (events carry no seq). */
  seq: number | null;
  previous: AgentStatus | null;
  /** False when the state was already present at first sight, i.e. its real start is unknown. */
  exact: boolean;
}

export type TransitionListener = (pane_id: string, from: AgentStatus | null, to: AgentStatus, pane: PaneInfo | AgentInfo) => void;

const RESEED_INTERVAL_MS = 60_000;
/** Changes found by polling within this long after (re)subscribing are expected, not a sign of a stale stream. */
const SUBSCRIBE_GRACE_MS = 10_000;

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
  /** When the tracker started watching; states first seen at that point began before it. */
  readonly startedAt = new Date();
  private subscribedAt = 0;

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

  /**
   * Feed an observation; records a transition when the status differs or the
   * pane's `state_change_seq` advanced. Returns true when a change was recorded.
   */
  observe(pane: PaneInfo | AgentInfo, seedOnly = false): boolean {
    const now = new Date();
    const seq = (pane as AgentInfo).state_change_seq;
    const prev = this.states.get(pane.pane_id);
    // Merge, never replace: pane_updated payloads carry no `name`/`terminal_title` and must not wipe them.
    if ((pane as AgentInfo).terminal_id) this.meta.set(pane.pane_id, { ...(this.meta.get(pane.pane_id) ?? {}), ...pane } as AgentInfo);
    if (!prev) {
      // First sight. During seeding the state predates us, so its start is unknown ("exact: false")
      // and nothing is reported (avoids a burst on startup). Afterwards a new agent is really new,
      // and one that is already blocked/done is a real event (e.g. a trust prompt right after spawn).
      const fresh = !seedOnly && this.ready;
      this.states.set(pane.pane_id, { status: pane.agent_status, since: now, seq: seq ?? null, previous: null, exact: fresh });
      if (fresh) this.emit(pane.pane_id, null, pane.agent_status, pane);
      return fresh;
    }
    const statusChanged = prev.status !== pane.agent_status;
    const missedChange = !statusChanged && seq != null && prev.seq != null && seq > prev.seq;
    if (!statusChanged && !missedChange) {
      if (seq != null) prev.seq = seq;
      return false;
    }
    const from = prev.status;
    this.states.set(pane.pane_id, { status: pane.agent_status, since: now, seq: seq ?? null, previous: from, exact: true });
    if (!seedOnly) this.emit(pane.pane_id, from, pane.agent_status, pane);
    return true;
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
    const known = new Set(this.states.keys());
    let missed = 0;
    for (const a of agents) if (this.observe(a, !this.ready) && known.has(a.pane_id)) missed++;
    for (const id of [...this.states.keys()]) if (!live.has(id)) this.forget(id);
    this.ready = true;
    const after = [...this.states.keys()].sort().join(",");
    // Heartbeat: an open subscription should have reported these changes already.
    if (missed && this.stop && this.subscribedAt && Date.now() - this.subscribedAt > SUBSCRIBE_GRACE_MS) {
      this.log(`tracker: polling found ${missed} change(s) the event stream missed; resubscribing`);
      this.resubscribe();
    }
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
        this.subscribedAt = Date.now();
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
