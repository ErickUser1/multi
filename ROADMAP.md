# What's missing

Each item comes with the context of why it isn't done and what got ruled out along
the way. If you're picking one up, that saves you retracing dead ends.

---

## Two ways to start a room

Right now every room starts empty and the agent scaffolds the project from
scratch. That's what makes any stack possible — you can ask for a Phaser game, a
Django API, whatever — but it costs a slow first minute and it's where things
break: a generator that creates a subfolder, a typo in the command, `npm install`
downloading the world.

Lovable doesn't scaffold at all. Their sandbox ships with the project already
built and dependencies installed; the agent only edits code. That's why their
first preview is instant — and also why you can't build a game with it.

**The idea:** offer both at room creation.

    Create room
      ├── Fast        → base project already installed, you're in within seconds
      └── From scratch → empty, the agent builds whatever you ask for

The user picks instead of us deciding. "From scratch" is exactly what exists
today, so nothing is lost; "fast" covers the common case (a web app) without
locking anyone in — and if you picked fast and later want another stack, the agent
can still swap it, just slower.

**Where:** the base project would be baked into `docker/room.Dockerfile` with
`node_modules` already in place, so it costs zero at room creation.

---

## Agents don't know what the other agents are doing

**Seen in a real session:** someone spawned `agente-1`, which started installing
dependencies. Seconds later someone else spawned `agente-2`, which looked at the
workspace, saw it empty (the first one hadn't finished writing yet), and started
installing dependencies too. Two agents doing the same work from second zero.

This is the exact problem Multi was built to solve — divergence from not seeing
what the other one is doing — except between agents. It got solved for humans
(they see the chat, the preview, the cursors) and overlooked for agents.

**Shape of the fix:** not the full context of the other agent's conversation —
that's expensive and mostly noise. A summary: who else is working, on what, and
which files they've touched. Enough for the second agent to notice that someone
is already setting the project up.

The data already exists: `AgentRegistry` tracks state and current task, and
`file-mutation.ts` keeps an ephemeral record of who wrote what. What's missing is
handing that to the model as part of its turn.

**Watch out for:** the summary has to be cheap to build and short enough not to eat
the context window. And it's a snapshot, not a subscription — by the time the model
reads it, it may already be stale. It should read as "this was the state when your
turn started," not as truth.

---

## Warm npm cache in the image

**The concrete reason:** the first `npm install` in a room takes minutes. Rooms are
born empty on purpose (no template, no assumed stack), but that means every room
downloads the world before anyone sees anything.

Lovable's first preview is nearly instant. There's no public detail on how, but
given their architecture (ephemeral container per project), the likely answer is
their image ships with `node_modules` already baked in.

**How to get that without giving up being stack-agnostic:** don't seed a project —
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

**What's missing:** what the app *stores* — the tables. An endpoint is programmer
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
already has the credentials from `.env` and a terminal — it can just ask the
database and report back what it finds.

**Watch out for, if you pick this up:** asking the database costs a connection, so
refresh when a turn that touched data closes, or on demand — not on every
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
reason isn't cosmetic: a human has a cursor because they move a mouse — there are
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

## Agent self-verification

The agent writes and says "done." It doesn't always check that it didn't break the
preview.

This matters more here than with a single-user agent: if it breaks the preview,
several people see a blank screen at the same time. The `bash` tool can already
run the build or the linter — what's missing is the prompt asking for it before
closing the turn, and the agent reading the dev server's logs.

In practice current models already do this fairly often on their own ("compiles
without errors"), so the work is making it reliable, not inventing it.

---

## Uploading files and images

You can't drag an image into the room for the agent to use. It's an obvious gap as
soon as someone wants to build something with real content.