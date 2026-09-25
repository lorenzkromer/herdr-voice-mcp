// Everything that hands something to an agent goes through here: prompts
// (send, spawn) and keys. Three concerns, shared by all writing tools:
//
//   1. handOver(): wait until the agent accepts input, retry while Herdr says
//      "not ready", and end in exactly one of three outcomes – delivered,
//      unknown (may have been typed; never retried) or failed (nothing arrived).
//   2. idempotent(): a caller-chosen request_id makes a retry after a dropped
//      connection return the first result instead of acting twice.
//   3. A log of recent handovers (the deliveries tool), failures included.

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HerdrError, type AgentInfo, type HerdrClient } from "./herdr.js";

export type HandoverOutcome = "delivered" | "unknown" | "failed";

export interface HandoverResult {
  outcome: HandoverOutcome;
  /** Agent state as returned by Herdr after a delivery. */
  agent?: AgentInfo;
  /** Why the outcome is not "delivered" (Herdr error code and message). */
  reason?: string;
  attempts: number;
  ms: number;
}

/** Herdr refused before typing anything, because the agent is not ready yet: safe to retry. */
const NOT_READY = /not_ready|not_idle|busy|launch_pending|not_found/;
/** The request may have reached the agent; retrying could deliver twice. */
const MAYBE_TYPED = new Set(["agent_prompt_stalled", "timeout", "connection_closed", "bad_response"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Hands a prompt to an agent within `budgetMs`. While Herdr reports the agent as not ready
 * (e.g. right after agent.start), it waits and retries; it never retries once the text may
 * have been typed.
 */
export async function handOver(client: HerdrClient, pane_id: string, text: string, budgetMs: number): Promise<HandoverResult> {
  const t0 = Date.now();
  const deadline = t0 + budgetMs;
  let attempts = 0;
  let pause = 300;
  let lastReason = "";
  for (;;) {
    // Readiness hint: a freshly started agent reports interactive_ready=false or launch_pending.
    // Errors here are not fatal; the prompt call below gives the authoritative answer.
    try {
      const info = await client.agentGet(pane_id);
      if ((info.interactive_ready === false || info.launch_pending) && Date.now() + pause < deadline) {
        lastReason = "agent not ready for input yet";
        await sleep(pause);
        pause = Math.min(pause * 2, 2000);
        continue;
      }
    } catch {
      /* fall through to the prompt call */
    }

    attempts++;
    const remaining = deadline - Date.now();
    try {
      const agent = await client.agentPrompt(pane_id, text, undefined, Math.max(5_000, Math.min(20_000, remaining)));
      return { outcome: "delivered", agent, attempts, ms: Date.now() - t0 };
    } catch (e) {
      if (!(e instanceof HerdrError)) return { outcome: "failed", reason: (e as Error).message, attempts, ms: Date.now() - t0 };
      const reason = `${e.code}: ${e.message}`;
      if (MAYBE_TYPED.has(e.code)) return { outcome: "unknown", reason, attempts, ms: Date.now() - t0 };
      if (NOT_READY.test(e.code) && Date.now() + pause < deadline) {
        lastReason = reason;
        await sleep(pause);
        pause = Math.min(pause * 2, 2000);
        continue;
      }
      return { outcome: "failed", reason: NOT_READY.test(e.code) ? `still not ready after ${Math.round((Date.now() - t0) / 1000)} s (${reason})` : reason || lastReason, attempts, ms: Date.now() - t0 };
    }
  }
}

// ------------------------------------------------------------------ log

export interface Delivery {
  at: Date;
  pane_id: string;
  handle: string;
  project: string;
  /** The prompt, or the key sequence for keys. */
  text: string;
  request_id: string | null;
  via: "send" | "spawn" | "keys";
  outcome: HandoverOutcome;
  /** Reason for unknown/failed. */
  reason?: string;
}

export const MAX_DELIVERIES = 100;
const deliveries: Delivery[] = [];

export function recordDelivery(d: Delivery): void {
  deliveries.push(d);
  if (deliveries.length > MAX_DELIVERIES) deliveries.splice(0, deliveries.length - MAX_DELIVERIES);
}

export function recentDeliveries(sinceMs: number): Delivery[] {
  return deliveries.filter((d) => d.at.getTime() >= sinceMs);
}

// ---------------------------------------------------------- idempotency

const REQUEST_ID_TTL_MS = 60 * 60_000;
const requests = new Map<string, { at: Date; result: Promise<CallToolResult> }>();

export function requestInFlight(tool: string, request_id: string): boolean {
  return requests.has(`${tool}\u0000${request_id}`);
}

export function clockSeconds(d: Date): string {
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * Runs `body` once per (tool, request_id). A repeated call returns the first result, marked as a
 * replay. Only results that changed something (structuredContent.effect === true) are kept;
 * refusals (unknown target, blocked agent, ...) may be retried with the same id.
 */
export async function idempotent(tool: string, request_id: string | undefined, body: () => Promise<CallToolResult>): Promise<CallToolResult> {
  if (!request_id) return body();
  for (const [k, v] of requests) if (Date.now() - v.at.getTime() > REQUEST_ID_TTL_MS) requests.delete(k);
  const key = `${tool}\u0000${request_id}`;
  const earlier = requests.get(key);
  if (earlier) {
    const r = await earlier.result;
    const first = r.content[0]?.type === "text" ? r.content[0].text : "";
    return {
      ...r,
      content: [{ type: "text", text: `Replay: request_id "${request_id}" was already handled at ${clockSeconds(earlier.at)}; nothing was done again. The original answer was:\n${first}` }],
      structuredContent: { ...(r.structuredContent ?? {}), replayed: true, first_handled_at: earlier.at.toISOString() },
    };
  }
  const entry = { at: new Date(), result: body() };
  requests.set(key, entry);
  try {
    const r = await entry.result;
    if (r.structuredContent?.effect !== true) requests.delete(key);
    return r;
  } catch (e) {
    requests.delete(key);
    throw e;
  }
}
