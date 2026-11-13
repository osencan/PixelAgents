# What's new in Pixel Agents 2.0

Pixel Agents 2.0 is built for **watching** many Claude Code and Codex sessions from a browser, including from other devices on your LAN, and for **steering** them through a guarded control surface: approving permission requests, starting agents and typing into them. Control is limited to the server's machine, or to devices unlocked with a PIN, and every control action is audited.

It keeps the 1.x office and continues from v1.6.0 as its own line; it will not be merged back. Credits are [at the end](#credits).

## What 2.0 adds

**More agents, correctly identified**

- Read-only **Codex** support: local Codex rollouts appear as characters (no Codex hooks or settings are changed). Codex subagents link to their parent.
- Each session has a stable identity, separate from its project label, so labels never swap characters. Project names follow the session's real working directory: git root, symlinks resolved, worktrees grouped with their main repository, and same-named projects told apart (`site (clients)` vs `site (personal)`). You can pin a project display name for every viewer.
- Hooks reach a server bound to a LAN address (`--host 192.168.x.y`), not only loopback.

**Honest statuses**

- One explicit state per agent (thinking, planning, reading, editing, running, waiting for permission or for input, idle, or unknown), marked **reported** (from a hook or log event) or **guessed**.
- Only a real permission event means "needs approval". A long command stays "running", with at most an "approval?" hint.
- Late events cannot bring an ended session back.

**Seeing what's going on**

- The label above each character shows status and project. Clicking a character opens a **side panel** with what it is doing, its time in the current state, what it asks approval for, this turn's tool steps, subagents, parent/linked agents, context use and recent history.
- Agents asking for approval light up with a pulsing beacon.
- Quiet notifications for approval requests, finished turns, failed tools and test/build results ("Tests passed" / "Build failed", taken from the real tool outcome).
- **Subtasks as agents (experimental, off by default):** with **Settings → Show Subtasks as Agents** on, each running `/subtask` (a fork of a Claude Code session) gets its own character beside its session's agent, with a compact label (_Subagent_ / activity / project), and leaves when it finishes. Known limit: a subtask shares its session's hooks, so its approval requests light up the main agent.

**Your own view (per browser)**

- **Filter** by provider and project. **Hide** agents without removing them: their card stays faded, and **Unhide** brings them back (this survives `/clear`).
- Role badges you assign (builder, reviewer, ...), project color accents, desk memory per project, and an optional day/night tint.

**Rooms with a purpose**

- Give each painted area a purpose: **Work**, **Rest**, **Waiting** or **Planning**. Idle agents go to the rest room (each to its own spaced tile) and sleep after a configurable delay of reported idle. Confirmed permission waits can walk to a waiting room. Claude sessions in plan mode can go to a planning room.

**Agent controls (opt-in)**

- **Who:** the token URL on the server's machine, or another device after **Filter → Agent controls → Unlock** with a 6–12 digit PIN (lockout after wrong tries, unlock expires when idle).
- **Approve or deny** Claude permission requests from the panel. Approvals are opt-in per project, show the full request, and are signed with a machine-local key. The terminal prompt keeps working in parallel.
- **Hire agents** into listed Directories and type into them in the terminal drawer.
- **Skip-permissions is disabled.** Sessions you started in your own terminal can be messaged only through Claude's Remote Control (`claude --remote-control`).

**Privacy on the LAN**

- Viewers without the token are read-only and receive tool activity as categories only ("Running a command", "Editing a file"): never file names, commands or prompt text. Full detail is for the tokened page.
- History is in memory, metadata only.

## Run it from source

Requires Node 20+.

```sh
git clone https://github.com/osencan/PixelAgents.git
cd PixelAgents
npm ci
npm run build
node dist/cli.js                                   # this machine only
node dist/cli.js --host 192.168.1.20 --port 3100   # also reachable on your LAN
```

The server prints a private URL with a token: use it to edit the office and see full details. Open the plain address (without the token) on other devices for a read-only view. Keep the token private.

Add `--no-terminal` for a watch-only office (no hiring agents, no terminals); approvals still work. Hook installation asks for your consent in the browser. Over plain HTTP the token and PIN cross your network unencrypted; prefer HTTPS (e.g. `tailscale serve`) on untrusted networks.

## Developing

`npm run check-types`, `npm run lint`, `npm run test:server`, `npm run test:webview`, `npm run build`. The browser e2e suite lives in `e2e/`.

## Credits

Pixel Agents 2.0 builds on [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents) 1.x by [Pablo De Lucca](https://github.com/pablodelucca) and its contributors. Thank you! It is not affiliated with or endorsed by the original project. Licensed MIT, like the original (see [LICENSE](LICENSE)).
