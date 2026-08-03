# Contributing

PRs are welcome. Here's what helps them get reviewed fast.

## Running it

```bash
npm install
npm run dev       # the server, on :4000
npm run dev:web   # the Room with HMR, on :5173
```

You don't need an API key to work on the engine: the demos use a mock agent (`MULTI_TEST_MOCK=1`). You do need one to test real agent behavior.

## Before sending the PR

```bash
npm run typecheck
```

And run the demo for whatever you touched. If it touches concurrency, `demo:concurrency`; if it touches isolation, `demo:aislamiento`. The full list is in the README.

## Where things live

| | |
|---|---|
| `server/src/agent/loop.ts` | the agent loop |
| `server/src/agent/tools/` | the 6 tools |
| `server/src/agent/providers/` | HTTP clients for the models |
| `server/src/engine/file-mutation.ts` | CAS: write only if nobody touched the file |
| `server/src/engine/keyed-mutex.ts` | queue by key (paths, repos, containers) |
| `server/src/engine/coordinator.ts` | one active turn per agent → real parallelism |
| `server/src/engine/container.ts` `runner.ts` | per-room isolation |
| `server/src/engine/preview.ts` | spinning up the project's dev server |
| `server/src/engine/proxy.ts` `inspector.ts` | proxy that injects click-to-select |
| `server/src/engine/git.ts` `history.ts` | commits, diffs, revert, bookmarks |
| `server/src/storage/` | SQLite behind an interface |
| `web/src/App.tsx` | the Room |

The full system walkthrough is in [E2E.md](E2E.md).

## Things worth knowing

**Every shared resource needs its lock.** The product is concurrent by design: several agents, several people, one project. Files, the git index, containers, and ports already go through `KeyedMutex`. If you add another shared resource, give it a lock from the start: concurrency bugs show up in production, not on your machine.

**The engine doesn't know about frameworks.** The room starts empty and the agent scaffolds whatever stack it's asked for. If you need something to work with a given stack, solve it by reading what the project declares or constraining the agent through the prompt, not by hardcoding `vite` into the engine.

**Concurrency errors go to the model.** If an agent tries to write a file that changed, the message is for it ("read it again"), not a modal for the human. That asymmetry is deliberate.

**No emojis in code or output.** Not in logs, not in UI messages.

**Comments explain why, not what.** If a comment describes what the code already says, cut it. If it explains a decision, a bug that got caught, or a constraint of the environment, it's worth keeping.

## Reporting something

If it's a bug, say what you expected and what happened. If you have the server log, even better. Most of this project's problems have come from reading that, not from reading the code.