# herdr-voice-mcp

An [MCP](https://modelcontextprotocol.io) server that lets you run a team of
coding agents by voice. You talk to Claude on your phone, and Claude hands
out work to the Claude Code and Codex sessions on your desk machine, checks
on them and reads back what they did.

It connects Claude to [Herdr](https://herdr.dev), a terminal multiplexer for
coding agents, through Herdr's local socket API. A small companion service
pushes a notification to your phone when an agent finishes or needs a
decision.

> Status: early, but used daily by the author. Single-user by design.
> Not affiliated with Herdr or Anthropic.

## What it feels like

You are out for a walk with earbuds in and the Claude app in voice mode.

- "How are things?" Claude calls `status` and tells you that two agents are
  working, one is done and one is waiting for approval.
- "Let's do a stand-up." Claude calls `standup` and narrates who finished,
  who has been stuck and for how long, with the last lines each agent
  printed.
- "Tell the web agent to run the tests and fix what fails." Claude calls
  `send`. The server confirms delivery right away. The agent keeps working
  on your machine.
- Your phone buzzes: "Acme Web App: finished". You ask "What's new?", and
  Claude reads it back.

## How it works

```
You (voice) → Claude app → Claude (Anthropic cloud)
                 → HTTPS → herdr-voice-mcp (your machine)
                 → Unix socket, JSON lines → Herdr → agent panes (Claude Code, Codex, …)

herdr-voice-notify (your machine) → Herdr event stream → ntfy / Pushover → your phone
```

Claude does not run on your phone or on your machine. It runs in the cloud,
so the MCP server needs a public, authenticated HTTPS address even when you
sit next to it. At your desk you can also use it locally from Claude Code
over stdio, without any network exposure.

Claude only answers when you speak. It cannot tell you on its own that an
agent finished. That is what the notifier is for: the phone gives you the
signal, Claude gives you the content.

## Tools

| Tool | What it does | Example request |
|---|---|---|
| `status` | Board of all allowed agents: status, project, workspace, time in the current state. `only: "attention"` limits it to blocked and done. | "How are things?" |
| `standup` | Finished and blocked agents with their last output lines. Remembers the time, so the next stand-up can tell new items from known ones. | "Let's do a stand-up." |
| `read` | Last lines of one agent's terminal. | "What is the backend agent asking?" |
| `send` | Delivers a prompt to an agent and acknowledges immediately. Watches a few seconds for an instant question or answer. Refuses an identical prompt to the same agent for 15 minutes unless `force` is set. Refuses while the agent is blocked. | "Tell the web agent to run the tests." |
| `wait` | Waits at most 25 seconds until an agent is ready, done or blocked. | "Is it done yet?" |
| `keys` | Sends logical keys to a blocked agent's dialog: `enter`, `esc`, `y`, `n`, arrows, `1`–`9`, `ctrl+c`. | "Say yes." / "Pick option two." |
| `spawn` | Starts a new agent of an allowed kind in an allowed project, in a new tab or workspace, optionally with a first task. | "Start a Codex in the shop project." |
| `projects` | Lists the allowed projects with keys and aliases. | "Which projects do you know?" |

Targets are resolved leniently: agent name, pane ID (`w4:p1`), project key,
name or alias, workspace label, tab label or part of the session topic. If a
target is ambiguous, Claude gets the list of candidates and asks back.

Herdr states: `working`, `blocked` (a question or approval dialog is on
screen), `done` (finished and not yet looked at in Herdr), `idle` (ready) and
`unknown`.

## Requirements

- **macOS or Linux.** The launchd templates are macOS-only. The server
  itself is plain Node and runs anywhere Herdr runs.
- **Node.js 22 or newer.**
- **Herdr 0.9 or newer** (socket protocol 22), running as a server with
  your agents inside it. Check with `herdr status server`.
- **A Claude client that supports remote MCP servers**: the Claude app
  (custom connectors) for mobile use, or Claude Code for local use.
- **A way to reach the server from the internet**, only for mobile use. The
  tested path is [Tailscale Funnel](https://tailscale.com/kb/1223/funnel).
  A reverse proxy on a public host works too, see below.
- **Optional:** an ntfy topic or a Pushover account for notifications; an
  OIDC provider such as Keycloak if you want login instead of a static
  token.

## Installation

```bash
git clone https://github.com/lorenzkromer/herdr-voice-mcp.git
cd herdr-voice-mcp
npm install
npm run build
npm test
```

Create the config:

```bash
mkdir -p ~/.config/agency
cp config.example.json ~/.config/agency/config.json
chmod 600 ~/.config/agency/config.json
scripts/gen-token.sh
```

Put the generated token into `auth.token` and list your projects under
`projects`. Only agents working inside those projects are visible.

## Using it locally with Claude Code

No network, no token. Claude Code starts the server itself:

```bash
claude mcp add --transport stdio agency -- node /path/to/herdr-voice-mcp/dist/server.js --stdio
```

Then ask Claude Code: "Let's do a stand-up."

## Running it permanently

On macOS, install the server and the notifier as launch agents. They start at
login and restart after a crash:

```bash
scripts/install-launchd.sh install
scripts/install-launchd.sh status
```

Logs go to `~/Library/Logs/herdr-voice-server.log` and
`~/Library/Logs/herdr-voice-notify.log`. After a config change run
`scripts/install-launchd.sh restart`.

The HTTP server listens on `127.0.0.1:8791` by default. Test it with:

```bash
node scripts/call-tool.mjs list
node scripts/call-tool.mjs status '{"only":"attention"}'
```

## Reaching it from your phone

### Option A: Tailscale Funnel with a token (tested)

1. Install and log in to Tailscale on the machine.
2. In the Tailscale admin console, enable HTTPS certificates under DNS.
3. Grant the funnel attribute in the tailnet policy file:

   ```json
   "nodeAttrs": [
     { "target": ["autogroup:member"], "attr": ["funnel"] }
   ]
   ```

4. Publish the port:

   ```bash
   scripts/funnel.sh on
   ```

   Tailscale prints the public address, for example
   `https://my-mac.tailnet-name.ts.net/`.

5. In the Claude app, add a custom connector. The Claude connector dialog
   has no field for headers, so the token goes into the URL:

   ```
   https://my-mac.tailnet-name.ts.net/mcp/<your token>
   ```

   Leave the OAuth fields empty.

6. Enable the connector in a chat and ask "What's new?".

Treat that URL like a password. Anyone who has it can control your agents.
To rotate it, generate a new token, update the config, restart, and update
the connector.

### Option B: reverse proxy on a public host (prepared, not yet verified)

If you already run a reverse proxy with TLS on a public server, it can
forward to your machine through a VPN such as WireGuard. The server can
listen on several addresses at once, for example localhost for Funnel and
the VPN address for the proxy:

```json
"http": { "host": ["127.0.0.1", "10.0.0.5"], "port": 8791 }
```

A Traefik file-provider example:

```yaml
http:
  routers:
    agency:
      rule: "Host(`agency.example.com`)"
      entryPoints: [websecure]
      service: agency
      tls: { certResolver: letsencrypt }
  services:
    agency:
      loadBalancer:
        servers:
          - url: "http://10.0.0.5:8791"
        passHostHeader: true
```

The machine must stay connected to the VPN, including after sleep and
network changes. If you add an uptime probe, it must expect `401`, never
`200`.

## Authentication

`auth.mode` selects what the server accepts:

| Mode | Accepts |
|---|---|
| `token` | A static token of at least 32 characters, as `Authorization: Bearer <token>` or as the last path segment `/mcp/<token>`. |
| `oauth` | An OIDC access token (JWT), verified against the issuer's JWKS: issuer, audience, `preferred_username` in `allowed_users`, group in `required_group`. |
| `both` | Either. Useful to keep the Funnel token route while you set up login. |

With OAuth configured and `public_url` set, the server publishes
[RFC 9728](https://www.rfc-editor.org/rfc/rfc9728) protected-resource
metadata at `/.well-known/oauth-protected-resource`. It does that only for
requests to the `public_url` host. Every other host, such as the Funnel
address, looks like a plain token endpoint. Otherwise the Claude connector
would try an OAuth flow there and fail. All other `/.well-known/*` paths
return 404 on purpose, for the same reason.

See `config.oauth.example.json`. A Keycloak client for this needs:

- confidential client, standard flow only, PKCE `S256`
- redirect URIs `https://claude.ai/api/mcp/auth_callback` and
  `https://claude.com/api/mcp/auth_callback`
- a group membership mapper (`groups` claim, no full path) and an audience
  mapper that puts the client ID into `aud` of the access token
- a group with exactly the users who may control the agents

In the Claude app, enter the public URL (`https://agency.example.com/mcp`)
and the client ID and secret under the connector's advanced settings.

## Notifications

Set `notify.enabled` to `true` and pick a provider:

- **ntfy**: install the ntfy app, subscribe to a long random topic, and put
  the topic into `notify.ntfy.topic`. Self-hosted ntfy servers work via
  `notify.ntfy.url` and an optional `token`.
- **Pushover**: put your user key and application token into
  `notify.pushover`.
- **log**: only writes to the log. Handy for testing without a phone.

Send a test message:

```bash
node dist/notify.js --test
```

On iPhone, enable "Announce Notifications" for the app to have them read
into your earbuds.

The notifier subscribes to Herdr's per-pane `pane.agent_status_changed`
events. It only reports agents in allowed projects, and it debounces repeated
transitions of the same pane.

## Security model

This service forwards instructions to agents that can write to your
repositories. It is built for one person and one machine.

- **Allow list.** Only agents whose workspace repository or working
  directory belongs to a configured project are visible or reachable.
  Without projects nothing is visible.
- **No shell passthrough.** `spawn` starts only the kinds listed in
  `agent_kinds`, only in a project root. `keys` accepts a fixed small set of
  keys.
- **Authentication on every request.** There is no unauthenticated path, not
  even for status.
- **Audit log.** Every call is appended to `~/.config/agency/audit.jsonl`
  with time, source, tool, shortened arguments and outcome. Every HTTP
  request is logged with the token masked.
- **Rate limit.** 120 requests per minute by default.
- **Kill switch.** `scripts/switch.sh off` makes the server answer 503 to
  everything without touching Herdr. `scripts/switch.sh on` reverts it.
- **Duplicate guard.** A dropped connection can make a delivered prompt look
  failed. `send` refuses the same text to the same agent for 15 minutes
  unless `force` is set.

Keep in mind that everything you dictate passes through the speech
recognition of the Claude app and through Claude. Decide consciously whether
that is acceptable for your code and your clients.

## Configuration reference

| Key | Default | Meaning |
|---|---|---|
| `socket` | `~/.config/herdr/herdr.sock` | Herdr API socket |
| `http.host` | `127.0.0.1` | Address or list of addresses to listen on |
| `http.port` | `8791` | Port |
| `http.path` | `/mcp` | Endpoint path |
| `public_url` | none | Public base URL, required for OAuth metadata |
| `auth.*` | `token` mode | See Authentication |
| `projects.<key>` | none | `name`, `root`, optional `aliases`, `extra_roots`, `default_kind` |
| `worktree_patterns` | `[]` | Worktree directories; `{repo}` is replaced by the project root's basename |
| `agent_kinds` | `["claude", "codex"]` | Kinds `spawn` may start |
| `rate_limit` | 120 per 60 s | Process-wide request limit |
| `audit_log` | `~/.config/agency/audit.jsonl` | Audit log file |
| `kill_switch` | `~/.config/agency/disabled` | While this file exists, HTTP answers 503 |
| `read.*` | 80 / 400 / 25 | Default, maximum and stand-up line counts |
| `send.settle_seconds` | `8` | How long `send` watches after delivery |
| `send.max_wait_seconds` | `25` | Upper bound for `wait` |
| `send.dedupe_minutes` | `15` | Duplicate-prompt window |
| `notify.*` | disabled | See Notifications |

The config is read from `--config <path>`, then `$AGENCY_CONFIG`, then
`~/.config/agency/config.json`, then `./config.json`. The token can also
come from `$AGENCY_TOKEN`.

## Known limitations

- **Tool calls must stay short.** The Claude connector drops calls that stay
  open for roughly 30 seconds or more. This is why `send` never waits for the
  agent to finish and `wait` is capped at 25 seconds. A dropped call may
  surface as a misleading network error in Claude.
- **Token in the URL.** The Claude connector dialog cannot send headers, so
  Option A puts the token into the path. It is masked in the server log, but
  it is visible in the connector settings.
- **OAuth with the Claude app is unverified.** The server side is
  implemented and checked against a real Keycloak (valid discovery,
  rejection of forged tokens). A full login from the Claude app has not been
  tested yet. It is open whether the app accepts a pre-registered client or
  insists on dynamic client registration.
- **Reverse proxy route is unverified.** Option B is documented but has not
  run end to end.
- **Herdr quirks.** Herdr's generic `pane.updated` event does not fire for
  every status change, for example `working` to `done`. The tracker
  therefore subscribes per pane and resubscribes when agents come and go.
  Agents that render on the terminal's alternate screen may lose scrollback,
  so `read` can only see the current screen for them.
- **Durations are approximate.** Herdr reports no timestamp for state
  changes. "For at least N minutes" means the server first saw that state N
  minutes ago.
- **Single user.** The stand-up memory and the duplicate guard live in the
  process and are shared by all callers.

## Open points

- End-to-end OAuth login from the Claude app, and a decision on dynamic
  client registration.
- Verifying the reverse proxy and VPN route, including reconnect after sleep.
- A persistent log of dictated tasks for review at the desk.
- Whether the server should offer git operations or leave them to the agents.
- Better handling of speech recognition errors in file names and technical
  terms beyond project aliases.

## Development

```bash
npm run dev                 # HTTP server via tsx
npm run dev -- --stdio      # stdio
npm run dev:notify          # notifier
npm test                    # unit tests with a fake Herdr socket
npm run typecheck
```

Source layout:

| File | Purpose |
|---|---|
| `src/herdr.ts` | Herdr socket client (one request per connection, streaming subscriptions) |
| `src/projects.ts` | Allow list and target resolution |
| `src/tracker.ts` | Watches state changes and remembers when they happened |
| `src/tools.ts` | MCP tool definitions |
| `src/format.ts` | Speech-friendly text output |
| `src/server.ts` | HTTP and stdio entry point, auth, rate limit, kill switch |
| `src/oauth.ts` | JWT verification and RFC 9728 metadata |
| `src/notify.ts` | Notification service |

Herdr's wire format, verified against Herdr 0.9.0: newline-delimited JSON over
a Unix socket, `{"id", "method", "params"}` requests, one request per
connection. `events.subscribe` keeps the connection open and streams events.
`herdr api schema --json` prints the full schema.

## License

MIT, see [LICENSE](LICENSE).
