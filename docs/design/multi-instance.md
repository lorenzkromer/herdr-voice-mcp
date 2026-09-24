# Design: one server for several Herdr instances

Status: **proposal, not implemented.** This records the plan so that the work
can start when a second machine actually exists. Until then, one server
controls exactly one Herdr instance.

## Goal

One MCP server, one connector in the Claude app, one board across several
machines that each run Herdr (for example `Office` and `Home`). "How are
things?" answers for all machines in one call. A task can never land on the
wrong machine because of an ambiguous target.

Non-goals: load balancing, moving agents between machines, more than a
handful of instances.

## What exists already

These parts were built with this plan in mind and need no redesign:

- `instance_name` in the config: a speakable name for the local instance,
  shown in `status`, `standup`, `projects` and in the server's `instructions`
  and `title` sent to the client.
- `AgentView.instance` and `instance` in every structured agent record.
- Target resolution accepts an instance prefix (`Office/shop/codex`, or just
  `Office`) and narrows the pool to that instance before resolving the rest.
  With one instance the prefix is only checked and stripped.

## Plan

### 1. Reaching the remote Herdr over SSH

Herdr's API is a local Unix socket. The remote socket is forwarded to a local
path over SSH, for example
`ssh -N -L ~/.config/agency/home.sock:/Users/<user>/.config/herdr/herdr.sock home-mac`,
kept alive by a launchd agent (or `autossh`). The server then talks to the
forwarded socket like to a local one; `HerdrClient` needs no change.

- Use a dedicated SSH key restricted to port forwarding
  (`restrict,port-forwarding,permitopen=...` or a `Match` block on the remote
  side). The forwarded socket must be mode 0600.
- Herdr's own one-request-per-connection protocol works over the forward;
  `events.subscribe` keeps one long-lived stream per instance.
- Latency is added to every call. Board calls to all instances run in
  parallel with a short per-instance timeout (about 5 s) so that a slow or
  unreachable machine cannot push a tool call past the client's ~30 s limit.

### 2. Instance list in the config

```json
"instances": [
  { "name": "Office", "socket": "~/.config/herdr/herdr.sock" },
  { "name": "Home",   "socket": "~/.config/agency/home.sock", "projects": { ... } }
]
```

- Backwards compatible: without `instances`, the implicit single instance is
  `{ name: instance_name, socket: socket, projects: projects }`.
- Projects are per instance, because paths differ between machines. A
  top-level `projects` map stays valid as the default for the local instance.
  The same project key may exist on several instances (same repo checked out
  on both machines).

### 3. One tracker per instance

Each instance gets its own `HerdrClient` and `Tracker` (subscription,
heartbeat, re-seed). The tracker's "service started" lower bound is per
instance too: a machine that was unreachable is only known since it came
back.

All process-wide maps keyed by pane id must be keyed by `(instance, pane_id)`
instead, because pane ids such as `w1:p1` exist on every machine:
`recentSends` (duplicate guard), `sendRequests` (request_id replay),
`deliveries`, `lastReads` (change hint) and the tracker states.

### 4. Merged board

`loadBoard` runs per instance in parallel and concatenates the agents. The
board text groups by status as today and names the instance in each line
("Office · Shop Backend: ..."). An instance that does not answer is reported
("Home is unreachable since 09:12") and does not fail the whole call; its
last known agents are not shown as current.

### 5. Instance name in every handle

With more than one instance, every handle starts with the instance:
`Office/shop-backend/codex`. With one instance, handles stay short as today.
Unqualified targets (name, workspace, project, ...) are still accepted and
resolved across all instances.

### 6. Notifier per instance

The notifier runs one tracker per instance in one process and puts the
instance into the push title ("Home · Shop Backend: finished"). Debounce keys
include the instance.

### 7. Where `spawn` starts

- An explicit instance prefix on `project` (`Home/shop`) or a new `instance`
  argument decides.
- Without one: if the project is configured on exactly one instance, it
  starts there. If it is configured on several, `spawn` refuses and asks
  back with the candidates. There is no silent default machine.

### 8. Safety rule for writing tools

`send`, `keys` and `spawn` change things; `status`, `standup`, `read`,
`wait`, `projects` and `deliveries` do not.

- A writing tool acts only when the target resolves to exactly one agent
  **and** that agent's instance is unambiguous. If an unqualified target
  matches agents on more than one instance, the tool refuses and returns the
  candidates with their instance-qualified handles, even when a reading tool
  would simply show all of them.
- A writing tool refuses when the target's instance is currently
  unreachable, instead of queueing.
- `request_id` replay and the duplicate guard work per instance, so a retry
  can never be redirected to another machine.

## Open questions

- Should `instance_name` default to the machine's hostname once there is more
  than one instance, or stay mandatory?
- Does the remote side need its own audit log, or is the central one enough?
- Kill switch: one for all instances, or one per instance?
