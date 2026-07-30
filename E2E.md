markdown
# How Multi works, end to end

This document describes **what the code does today**, not what's planned. It's the
map for understanding the whole system: from an empty room to a finished project.

What's missing and why is in [ROADMAP.md](ROADMAP.md).

---

## The full walkthrough

┌──────────────────────────────────────────────────────────────────────────────────┐
│ E2E — FROM AN EMPTY ROOM TO A FINISHED PROJECT │
└──────────────────────────────────────────────────────────────────────────────────┘

① JOIN
You create the room → POST /rooms → folder + git init + .gitignore
(EMPTY: zero template)
You share the link → your teammate joins with their name
their key stays local (localStorage)
│
Both see: chat, cursors, "the room is empty"

② ASK FOR THE PROJECT
"@agente build me a notes app"
│
├── chat or order? ── no @ → nobody wakes up
│ (without this you can't talk to your teammate without invoking the agent)
│
├── do you have a key? ── no → error:key ONLY to you, the room doesn't know
│
└── spawn an agent → shows up in the list with its color

③ THE FIRST TIME AN AGENT WORKS
ensureRunner → docker run → the room's container
workspace mounted at /work
2gb, 2 cpus, no privileges

④ THE LOOP (while + switch, no framework)
┌────────────────────────────────────────────────────────────┐
│ provider.stream(system, messages, tools) │
│ │ │
│ ├─ text_delta ──→ agent:delta ──→ streaming to │
│ │ EVERYONE'S chat │
│ │ │
│ └─ stop_reason? │
│ ├─ end_turn ──────────────→ EXITS the loop │
│ └─ tool_use ──┐ │
│ ▼ │
│ Promise.all(ALL the tools at once) │
│ read/grep/glob → straight to disk │
│ write/edit → CAS + mutex (⑤) │
│ bash → docker exec (isolated) │
│ │ │
│ tool_result ──→ back to the top │
└────────────────────────────────────────────────────────────┘
(max 50 turns)

⑤ WHEN TWO AGENTS COLLIDE
Agent-1 → Menu.jsx ─┐ different keys
Agent-2 → App.jsx ─┘ → both at once, no waiting

Agent-1 → Menu.jsx ─┐ same key
Agent-2 → Menu.jsx ─┘ → the 2nd one queues
│
KeyedMutex: each write goes through whole, no interleaving
│
CAS: is what you read still there?
├─ yes → write (temp + rename, atomic)
└─ no → StaleContentError TO THE MODEL:
"it changed, read it again"
→ the agent reapplies on top
→ BOTH changes survive

While waiting: "Agent-2 waiting on Agent-1 (Menu.jsx)"
That wait does NOT count toward the timeout — it's a queue, not stuck work.

⑥ TWO CHANNELS, TWO SPEEDS
┌─ REAL TIME ───────────────────┐ ┌─ SAVED ──────────────────────┐
│ every write → file:changed │ │ when the turn CLOSES: │
│ → HMR → the preview moves │ │ ONE commit (5 files = 1) │
│ does NOT wait on commits │ │ → history:new → history │
└────────────────────────────────┘ └───────────────────────────────┘
"now" "memory"

⑦ THE PREVIEW APPEARS ON ITS OWN
when the turn closes → detectLaunch: is there already a package.json with "dev"?
├─ no → keeps waiting (normal)
└─ yes → npm install (inside) → dev server (inside)
→ Docker publishes the port → the proxy injects the inspector
→ preview:ready → EVERYONE sees it appear

⑧ ITERATE — the product's real loop
Someone clicks a button in the preview
→ the (injected) inspector sends selector + tag via postMessage
→ everyone sees "beto selected <button>"
"make this button red" (anchored)
→ the agent gets the selector in its prompt
→ finds the code, changes it
→ ⑥ again: both see it turn red

⑨ IF SOMETHING GOES WRONG
History → drag to a previous point → "Go back here"
→ revert as a NEW commit (never erases history)
→ everyone returns to that state

⑩ SHUTTING DOWN
Ctrl+C → previews killed, containers removed
Coming back: the room persists (SQLite), the chat persists, the project persists (git)
the preview restarts on its own


---

## The five pieces that hold it all up

**The loop is a `while` with a `switch`.** No agent frameworks, no model SDK. Sends
messages, receives `tool_use`, executes, repeats until `end_turn`. Tools from the
same message run in parallel (`Promise.all`).

**The concurrency error goes to the MODEL, not the human.** If the file changed,
the agent gets "read it again" and reapplies its change on top of the new content.
Nobody sees a conflict modal. This replaced the structural merge we'd originally
designed: it's cheaper to have the agent retry than to merge text.

**Two independent channels.** The preview doesn't wait on commits (if it did, the
room would feel dead between turns) and the history doesn't save every keystroke
(a turn that touches 5 files is ONE point on the timeline, not five).

**The engine doesn't know about stacks.** The room starts empty; the agent
scaffolds whatever it's asked for. The preview reads `package.json` to know how to
launch it, and the proxy injects the inspector regardless of framework.

**The container makes true what the tools promise.** `safePath` already stopped
`write_file` from leaving the workspace, but a shell can't be constrained from
code: `cwd` says where it starts, not how far it can reach. Actually locking it
down has to be the operating system's job.

---

## Where the loop runs and where the key travels

The loop runs **on the server**, always. It couldn't run in the browser even if we
wanted it to: it needs the workspace filesystem, git, and `docker exec`.

The API key doesn't travel with every message. It's sent **once, when the socket
connects**, and the server keeps it in memory tied to that `socketId`:

browser server
─────── ──────
on connect:
emit("auth:key", {key}) ──────► keys.ts: Map<socketId, key>

every turn:
emit("chat", {text}) ──────► providerFor(socket.id)
↓ looks up the key by socketId
new AnthropicProvider(key)
↓
runAgent({ provider, ... }) ← the loop, here
↓
fetch → api.anthropic.com


**The consequence worth saying out loud:** whoever hosts Multi has, in their
process's memory, the keys of everyone who joins their rooms. On your own machine
with your teammates, that's harmless. On a public service open to strangers, it
isn't — and it's one of the reasons a paid hosting offering would end up supplying
its own key and charging for usage, instead of taking other people's.

### Who can read that Map

| | |
|---|---|
| The server process | yes — it needs the key in the clear to call the API |
| Whoever hosts it | yes — `console.log`, a debugger, or a process dump |
| Root on that machine | yes — can read the memory of any process |
| Other members of the room | **no** — no event emits keys, and the Map is indexed by `socketId` |
| **The agents** | **no** — they run inside the container, which can't reach the server's memory. Asking an agent "show me the keys" gets you nowhere: they're not in its world |
| Disk | **no** — never written; they're gone on restart |
| Logs | **no** — never logged, not even truncated |

The trust model is **"you trust whoever's hosting it"** — the same one you already
accept with Vercel and your environment variables. Trivially true locally (you're
the host); stops being true on an open cloud.

**Mitigation if you ever host it publicly:** Anthropic lets you create keys with a
spending limit. Anyone joining someone else's Multi should use a capped one, not
their main account's key — it turns the worst case of "my account got drained"
into "I lost a few bucks."

---

## Where things live

| | |
|---|---|
| `server/src/agent/loop.ts` | the loop |
| `server/src/agent/tools/` | the 6 tools |
| `server/src/agent/providers/` | HTTP client to Anthropic (hand-rolled SSE) |
| `server/src/engine/file-mutation.ts` | CAS |
| `server/src/engine/keyed-mutex.ts` | queue by path |
| `server/src/engine/coordinator.ts` | one drain per agent → real parallelism |
| `server/src/engine/turns.ts` | durable turns + orphan sweep |
| `server/src/engine/git.ts` `history.ts` | commits, diffs, revert, bookmarks |
| `server/src/engine/preview.ts` | spinning up the dev server |
| `server/src/engine/proxy.ts` `inspector.ts` | proxy that injects click-to-select |
| `server/src/engine/container.ts` `runner.ts` | per-room isolation |
| `server/src/keys.ts` | per-person API key (memory, never on disk) |
| `server/src/storage/` | SQLite behind an interface (a door to Postgres) |
| `web/src/App.tsx` | the room |

---

## What's verified

| What | How |
|---|---|
| Engine: empty workspace → preview + HMR | `npm run demo:workspace` |
| Concurrency: CAS, mutex, coordinator | `npm run demo:concurrency` — 17/17 |
| History: diffs, bookmarks, revert | `npm run demo:historial` — 9/9 |
| Persistence: survives a restart | `npm run demo:persistence` |
| Visual backend: endpoints and status | `npm run demo:back` — 12/12 |
| Isolation: the agent can't leave its room | `npm run demo:aislamiento` — 10/10 |
| Per-person keys | `npm run demo:keys` — 6/6 |

**What's still untested:** the ② → ⑦ path with a real agent — asking for a project
from scratch and watching it appear. The pieces are verified individually; the mock
the demos use writes a fixed file and doesn't know how to scaffold.

---

## Environment notes

- **WSL:** importing Fastify from `/mnt/c` takes ~55s (Windows translating
  thousands of `node_modules` reads). It's not hanging. Moving the repo to the
  Linux filesystem fixes it.
- **Without Docker** the server still starts, in local mode, and warns loudly that
  there's no isolation. It never degrades silently.