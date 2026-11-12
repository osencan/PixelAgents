# About this fork

This is a community fork of [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents) (based on v1.6.0) focused on **watching** several Claude Code and Codex sessions from a browser, including from other devices on your LAN. It is not affiliated with or endorsed by the upstream project; all credit for Pixel Agents itself goes to its authors. Licensed MIT, like upstream (see [LICENSE](LICENSE)).

The fork keeps the upstream office and adds observation features. It does **not** add any way to control agents from the browser.

## What it adds

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

**Your own view (per browser)**

- **Filter** by provider and project. **Hide** agents without removing them: their card stays faded, and **Unhide** brings them back (this survives `/clear`).
- Role badges you assign (builder, reviewer, ...), project color accents, desk memory per project, and an optional day/night tint.

**Rooms with a purpose**

- Give each painted area a purpose: **Work**, **Rest**, **Waiting** or **Planning**. Idle agents go to the rest room (each to its own spaced tile) and sleep after a configurable delay of reported idle. Confirmed permission waits can walk to a waiting room. Claude sessions in plan mode can go to a planning room.

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
node dist/cli.js --no-terminal                      # local only
node dist/cli.js --host 192.168.1.20 --no-terminal   # also viewable on your LAN
```

The server prints a private URL with a token: use it to edit the office and see full details. Open the plain address (without the token) on other devices for a read-only view. Keep the token private.

`--no-terminal` keeps the office watch-only (no launching agents from the browser), which is how this fork is meant to be used. Hook installation still asks for your consent in the browser, as upstream does.

## Developing

Same as upstream: `npm run check-types`, `npm run lint`, `npm run test:server`, `npm run test:webview`, `npm run build`. The browser e2e suite lives in `e2e/`.
