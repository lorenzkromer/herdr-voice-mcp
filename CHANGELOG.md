# Changelog

## Unreleased

### Read API for dashboards
- `GET /api/agents` and a server-sent-events stream `/api/agents/stream` with
  the agent fields of `status` across all instances, including when each
  state began. Strictly read-only, no terminal output.
- Dedicated read tokens, accepted only in the `Authorization` header;
  credentials in the query string are refused. CORS only for configured,
  exact origins.

### Several machines
- One server controls the agents on several Herdr instances with one merged
  board: `instances` in the config, each with its own socket (forwarded over
  SSH), projects, Herdr client and tracker.
- Handles start with the instance name; targets that match on more than one
  machine are ambiguous, including repeated pane ids and workspace names.
- An instance that does not answer is reported as not reachable instead of
  failing the call; meanwhile `send`, `keys` and `spawn` only accept targets
  that name their machine.
- `spawn` starts on the only machine that has the project, or asks; new
  `instance` argument and `<instance>/<project>` form.
- `projects` lists each machine; the notifier watches all machines.
- `scripts/tunnel.sh` and a launchd template keep an SSH socket forward up
  with a forward-only key, in either direction (`install-reverse` lets a
  server on another machine reach this one).
- systemd user units for running server and notifier on Linux.

## 0.2.0 – 2026-09-25

Fixes and features from the first days of daily voice use.

### Delivery
- One handover path for `send` and `spawn`: waits until the agent accepts
  input, retries while Herdr reports it as not ready (within a fixed time
  budget), never retries once the text may have been typed, and reports
  exactly one outcome: delivered, outcome unknown, or not delivered.
- `spawn` hands the first task over once the new agent is ready and says
  explicitly when only the agent started and the task still has to be sent.
- `request_id` for `send`, `spawn` and `keys`: a retry with the same id
  returns the first result and never acts twice.
- New tool `deliveries`: recent handovers by `send`, `spawn` and `keys`
  with their outcome, filterable by agent or `request_id`.
- `send` watches 3 seconds after delivery by default (was 8).

### Addressing
- Stable, speakable handles `<workspace>/<name or kind>`, shown by `status`
  and `standup` and always accepted as a target.
- A word that is one agent's name and another agent's workspace is reported
  as ambiguous instead of silently picking the name.
- Spoken pane ids (`w1y p1`, `W1Y-P1`), qualified targets
  (`<workspace or project>/<agent>`) and an optional instance prefix.
- The most specific matching project root wins, independent of config order.

### Status and stand-up
- Missed state changes are detected via Herdr's `state_change_seq`; the event
  subscription is rebuilt when polling finds changes it missed.
- States that predate the service are reported as "since before <start>"
  instead of a duration that looks precise.
- `instance_name` config: a speakable name for the Herdr instance, shown in
  `status`, `standup`, `projects` and the server info sent to the client.

### Reading
- `read` falls back to a raw pane read while the agent is busy, filters more
  terminal chrome, and reports the read time and whether the screen changed
  since the previous read.

### Spawning
- Optional `placement`: `tab` (default), `workspace` (own workspace) or
  `worktree` (own Git branch and checkout, grouped under the project).
- `spawn` finds the project's open workspace by spoken-style label or by
  agents already working in the project root, instead of creating a second,
  similarly named workspace; a new workspace never gets such a label.

### Server
- Newer MCP protocol versions announced by the client are mapped to the
  newest one the SDK supports instead of failing with HTTP 400.
- The reason for every rejected MCP request is logged.
- The notifier stays idle when disabled instead of exiting (which made
  launchd restart it every few seconds).

### Docs
- Design note for controlling several Herdr instances from one server:
  `docs/design/multi-instance.md`.

## 0.1.0 – 2026-09-23

Initial release.
