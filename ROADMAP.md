# What's missing

Each item comes with the context of why it isn't done and what got ruled out along
the way. If you're picking one up, that saves you retracing dead ends.

---

## Done: max_tokens adapts to what the key can afford

**The bug:** OpenRouter rejects requests with a 402 (*"This request requires more
credits, or fewer max_tokens"*) **before the model even runs**. It checks your
key's budget against the *maximum possible output*, not what the response would
actually cost. Asking for 8192 tokens got a request rejected that would have used
200. Free-tier keys and low balances hit this constantly, which made Multi look
broken when the fix was one number.

**What shipped** (`providers/openai-compat.ts`): a 402 is now two different
things, and they're told apart by the provider's own message.

- *"can only afford N"* means there **is** money, the ceiling was just too high.
  The client retries immediately with 90% of N. No backoff: waiting doesn't grow
  a balance.
- No such number means the account is actually empty. Fails right there, with one
  attempt, saying so.

Two details worth keeping if you touch this:

**There's a floor** (512). Below roughly that, the model gets cut mid tool call
and returns truncated JSON, which reads as an agent bug when it's really a money
problem. If the affordable ceiling is under the floor, it fails loudly instead.

**The user-facing message comes before the generic credits one** in
`explicarFalla`. Both mention balance, and in the wrong order someone with money
gets told to go top up.

Covered by `demo:presupuesto` (16/16), with a fake server that charges upfront
like OpenRouter does. No network, no API key.

**Note:** OpenCode doesn't solve this. Its `maxOutputTokens` is a static min of
the model's limit and a fixed cap (`provider/transform.ts`), computed from model
capability and never from account balance. Nothing there handles a 402. Charging
against the maximum possible output is an OpenRouter billing quirk, so there was
nothing to copy.

---

## Done: a cut-off turn keeps what it already did

**The bug, seen in a real session:** an agent failed three times in a row with
*"the model's response was cut off mid-write"*. Each attempt re-read the whole
project from scratch. Typing `@agente continua` didn't help. As far as the agent
was concerned, that turn never happened.

**The cause:** `runAgent` makes a *copy* of the history it receives, so the whole
turn grows in a local array. The success path and the interrupt path both return
it; the error path threw and the array went with the stack.

**What shipped:** an `onProgreso` callback that mirrors the array out before every
`throw` and on every normal exit, so the caller always has the latest version
regardless of how the turn ended. On failure the server now saves that history, and
commits whatever the agent wrote as a point on the room's timeline (marked as cut
off) instead of leaving it uncommitted and invisible.

Two details worth keeping if you touch this:

**The rescued history is already valid.** The `throw` in the loop happens *before*
the assistant message is pushed, so what survives are complete rounds with every
`tool_use` paired to its `tool_result`, the invariant the API requires. Nothing
needs sanitizing; a partial save done wrong would break the *next* turn.

**The turn stays `failed`.** `state` and `commit` are independent fields on `Turn`,
so a turn can be marked failed and still carry its hash: `state` says how it ended,
`commit` says where the work landed.

Covered by `demo:turno-cortado` (12/12), with a scripted fake provider. No network,
no API key.

**On the messages you type while it's down:** `dispatchAgent` already coalesces
anything that arrives *while the agent is running* into a single turn
(`pending.join("\n\n")`), and re-queues it on failure so nothing is silently
dropped. What it can't group is a message typed after the turn already failed and
the agent went idle: that starts a fresh turn. With the history now surviving, that
matters much less than it used to, since the fresh turn opens with everything the
cut-off one had done.

---

## Considered and rejected: a shared task list

Claude Code's agent teams coordinate through a shared task list plus a mailbox:
the lead creates tasks, teammates claim them, dependencies unblock automatically.
It's the standard answer to "how does the work fit together at the end."

**Multi doesn't need it, and adding it would cost more than it gives.**

Their lead is an agent that can't see anything, so it needs a board to know the
state. In Multi the coordinators are people who are *looking at the same screen*.
The board is the preview.

Three things already cover it:

- Agents get a summary of what the others are doing when their turn starts
- The shared preview: if two pieces don't fit, everyone sees it within seconds
- The chat: people coordinate by talking, like two people who work together

A list that repeats what was already said in the chat is upkeep for nobody. And a
list that starts *directing* work turns the room into an orchestrator with one
boss, which is exactly the thing Multi isn't.

**What the list wouldn't have fixed either:** an agent saying "done" after breaking
the build. That's the real gap, and it's covered under agent self-verification
above. The agent checking its own work is worth more here than a board tracking it.

Worth noting that Claude Code documents this failure mode in their own limitations:
*"teammates sometimes fail to mark tasks as completed, which blocks dependent
tasks."* Coordination machinery isn't a guarantee.

---

## Two ways to start a room

Right now every room starts empty and the agent scaffolds the project from
scratch. That's what makes any stack possible: you can ask for a Phaser game, a
Django API, whatever. But it costs a slow first minute and it's where things
break: a generator that creates a subfolder, a typo in the command, `npm install`
downloading the world.

Lovable doesn't scaffold at all. Their sandbox ships with the project already
built and dependencies installed; the agent only edits code. That's why their
first preview is instant, and also why you can't build a game with it.

**The idea:** offer both at room creation.

    Create room
      ├── Fast        → base project already installed, you're in within seconds
      └── From scratch → empty, the agent builds whatever you ask for

The user picks instead of us deciding. "From scratch" is exactly what exists
today, so nothing is lost; "fast" covers the common case (a web app) without
locking anyone in. And if you picked fast and later want another stack, the agent
can still swap it, just slower.

**Where:** the base project would be baked into `docker/room.Dockerfile` with
`node_modules` already in place, so it costs zero at room creation.

---

## Done: agents see what the other agents are doing

**The bug, seen in a real session:** someone spawned `agente-1`, which started
installing dependencies. Seconds later someone else spawned `agente-2`, which
looked at the workspace, saw it empty (the first one hadn't finished writing yet),
and started installing dependencies too. Two agents doing the same work from
second zero.

This was the exact problem Multi was built to solve, divergence from not seeing
what the other one is doing, except between agents. Solved for humans (they see
the chat, the preview, the cursors) and overlooked for agents.

**What shipped** (`resumenDeOtros` in `engine/agents.ts`): when a turn starts, the
agent gets a summary of who else is working, on what, which files they're writing
*right now* versus already released, and the last thing each one said in the chat.
Not the other agent's full conversation: that's expensive and mostly noise.

Including what they *said* turned out to matter more than expected: the file list
says which file the other one touches, but not the decisions behind it ("the data
goes in `src/data/personajes.ts`, typed like this"). That only lives in what they
told the room, and it saves the next agent from rediscovering it or reinventing it
differently.

Verified with two real agents in parallel: `agente-2` said out loud *"I'll do Level
I in a new file so I don't step on what agente-1 is touching."* Covered by
`demo:agentes-se-ven` (12/12).

**Known limit:** it's a snapshot, not a subscription. It reads as "this was the
state when your turn started," not as truth. By the time the model acts on it, it
may be stale.

---

## Warm npm cache in the image

**The concrete reason:** the first `npm install` in a room takes minutes. Rooms are
born empty on purpose (no template, no assumed stack), but that means every room
downloads the world before anyone sees anything.

Lovable's first preview is nearly instant. There's no public detail on how, but
given their architecture (ephemeral container per project), the likely answer is
their image ships with `node_modules` already baked in.

**How to get that without giving up being stack-agnostic:** don't seed a project,
warm the npm cache in the room image with the packages that get asked for most
(react, vite, tailwind, typescript). If the agent asks for Svelte or Django it
downloads them like today; the common case is just already there.

The difference matters: a template *decides the stack for the user*; a cache *has
ready what they'll probably ask for*. The first breaks the product's premise, the
second doesn't.

**Where:** `docker/room.Dockerfile`, with `npm cache add` at build time.

---

## The full visual backend

**What's there:** a map of endpoints. It scans the workspace and cross-references
what the front end calls (`fetch`, `axios.*`, `useSWR`) against what the back end
declares (`app.get`, `router.post`, file-convention routes). One card per endpoint
with a status light: dotted (front calls it, doesn't exist), green (exists and is
used), gray (exists, nobody calls it). Updates live. See `engine/api-map.ts` and
`web/BackCanvas.tsx`.

**What's missing:** what the app *stores*: the tables. An endpoint is programmer
language; `GET /api/pedidos` tells someone who doesn't code nothing. What a
teammate needs to know to avoid colliding with you is *what this saves*.

**Why it matters in multiplayer:** if your teammate made orders get saved and you
never find out, you build something that collides and end up bolting together two
back ends that don't know about each other. It's the exact problem the project was
born from.

**Dead ends already walked:**

- **Reading the migrations.** They're an incremental history (`create table`, then
  `add column`, then `drop column`). Knowing what the table looks like today means
  replaying them in order, in the right dialect. And plenty of people don't use
  migrations.
- **A `schema.sql` the agent keeps in sync.** That's a hand-synced copy, and copies
  drift. It'd be an artifact that exists only to make the screen look right.
- **Reading the ORM file** (`schema.prisma`, `models.py`). Doesn't cover anyone
  running queries straight from their provider's dashboard. That workflow is
  legitimate, leaves the database in perfect shape, and the project with zero
  trace of it.

**Where the reasoning landed:** every path above reads *representations* of the
schema, and a representation can lie. The only source that can't lie about itself
is the live database. And there's no need to write a client per engine: the agent
already has the credentials from `.env` and a terminal. It can just ask the
database and report back what it finds.

**Watch out for, if you pick this up:** asking the database costs a connection, so
refresh when a turn that touched data closes, or on demand, not on every
`file:changed`. If there are no credentials or the database is down, say so ("couldn't
connect"), never show empty in a way that reads as "no tables." Structure yes, data
no by default: in a shared room, rows can be sensitive.

---

## Migrating the runtime to Bun

**The concrete reason:** starting the server takes about 5 minutes on WSL over
`/mnt/c`. Most of that is Node reading thousands of `node_modules` files through
Windows' translation layer. Measured on the same machine, same folder: importing
Fastify takes **~55s on Node vs. 6.2s on Bun**.

**The blocker:** `node:sqlite` doesn't exist in Bun (`No such built-in module`).
It's the API persistence uses. Bun has its own (`bun:sqlite`), with a different
shape.

**Why the blocker is small:** data access already lives behind the `Storage`
interface (`server/src/storage/types.ts`), precisely so the engine can be swapped.
It'd mean writing a `storage/bun-sqlite.ts` sibling to the current one and picking
one at startup based on the runtime. Nothing else in the system touches it. The
rest of the APIs we use (`child_process`, `fs`, `http`, `net`, `path`, `stream`,
`util`) are already covered.

**What you also get besides speed:** single-file executables. The entry point
would go from *"clone, install Node 22, npm install"* to *"download this and run
it."*

---

## The agent's cursor over the preview

Right now humans have a live cursor over the stage and the agent doesn't. The
reason isn't cosmetic: a human has a cursor because they move a mouse: there are
coordinates to transmit. The agent has no mouse.

To draw its position you'd need to know that *"it's editing `Pedidos.tsx`"*
corresponds to *that specific block* on the screen. Between the file and the
pixels there's a compiler that erases that trace.

**Possible path:** some frameworks' build plugins tag each element with its origin
(`data-source`). If the DOM element knows which file it came from, the inspector
can highlight what the agent is touching. The downside is it depends on the
framework, so it'd need to degrade cleanly: if there's origin info, highlight it;
if not, fall back to the text notice that already exists.

**Cheaper middle ground:** when someone anchors a message to an element, the
selector already traveled over the socket. At that point you do know which
element it is, without solving the general mapping problem.

---

## Previewing a past state

History lets you see a point's diff and go back to it, but not *look* at how the
app appeared at that moment without committing to it.

The problem: the project on disk is source code. The dev server translates it on
the fly; serving a commit's tree as static files hands over raw JSX the browser
can't run.

**Recommended path:** on-demand build. When previewing, run that commit's build
into a temp folder and serve the result. Real fidelity, a few seconds the first
time and then cached. Needs to reuse the workspace's `node_modules` via symlink so
it doesn't reinstall on every preview. `engine/git.ts` already has `extractTo` to
pull a commit's tree without touching the working tree.

---

## Editing a past message

Right now, correcting course is two moves: go back to a point in history, then ask
for something else. It'd feel more natural to edit the message you sent and have
the system rewind to that point and retry with the new instruction.

The data already exists: messages are persisted with their turn, and every turn
has its commit.

---

## Hosting

Multi runs locally today. To actually host it, still missing:

- **Shutting down idle rooms.** Every room spins up a container and a dev server;
  without auto-shutdown you pay RAM for people who already left.
- **HTTPS with your own domain.** The tunnel works for one session, not for
  something permanent.
- **No fallback credential.** In an open service, strangers would burn through the
  `.env` key. Everyone brings their own, no exceptions.
- **And a trust decision:** whoever hosts it has, in their process's memory, the
  keys of everyone who joins their rooms (see [E2E.md](E2E.md)). On your own
  machine with your team, that's harmless; on a public service open to strangers,
  it isn't. It's why a paid hosting offering would end up supplying its own key
  and charging for usage.

---

## Done: agent self-verification

The agent used to write and say "done" without checking it hadn't broken the
preview. That matters more here than with a single-user agent: several people see
the blank screen at the same time, without knowing why or since when.

**What shipped:** the `<antes_de_cerrar>` section of the system prompt
(`agent/loop.ts`). It asks for a check with whatever command fits the stack: build,
typecheck, tests. Never a hardcoded `npm run build`, because a Go or Python
project doesn't have one. The loop already iterates up to 50 turns, so the agent
writes, verifies, fixes and re-verifies *inside the same turn*; nothing had to be
re-triggered.

Two things learned tuning it:

- **It also fixes what someone else broke.** An earlier version let the agent defer
  ("that file belongs to another agent"), which left errors unfixed in silence when
  the other agent had already finished its turn. Removing that permission (less
  rule, more judgment) worked better.
- **It must not start its own dev server.** It was launching them to check, leaving
  orphans competing for the container's memory (four stray logs found in `/tmp` in
  one session). The prompt now says Multi already has one running and to read its
  log instead.

**The honest limit, which is why this doesn't close the parallelism problem:** it
detects fast, it doesn't prevent. Two coupled pieces handed out at the same time
will still collide: agent A changes a signature after agent B already shipped code
against the old one, and B is gone. What changes is that whoever closes *last* sees
the final state and fixes it, so it surfaces in seconds instead of at the end.

**Not done: serializing the checks.** If two agents build at once, both could see
the same breakage and both try to fix it. The fix would be a `KeyedMutex` keyed on
the workspace, same pattern already used for git's index and container startup.
the second one queues, and when its turn comes it sees the state *with* the first
one's work already written. Left out until it's actually observed: right now it's a
guess about a race, and the check takes seconds while turns take minutes.

---

## Uploading files and images

You can't drag an image into the room for the agent to use. It's an obvious gap as
soon as someone wants to build something with real content.