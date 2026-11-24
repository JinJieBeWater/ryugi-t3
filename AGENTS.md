# ryugi-t3

ryugi-t3 is the Ryugi custom host for T3 Code. It delivers artifact feedback to the T3 thread that subscribed to it. One maintainer runs it on macOS.

## What we never compromise on

### Feedback reaches the thread exactly once

Ryugi reads only the exit code. 0 means delivered, 10 means the thread is gone and Ryugi unsubscribes, and any other code makes Ryugi retry. Once T3 has accepted a message, the command must exit 0; any other code makes Ryugi send it again. Two things follow. `deliver.cjs` treats a send with a lost receipt as delivered when the thread's last user message matches it. `hosts.t3.timeoutMs` stays above the worst case of three `t3` calls at 10 seconds each, because Ryugi kills a command that runs past it and sends again.

### Watchers never fight over a session

The hub keeps only the newest connection for each session, and a Ryugi watcher exits once it is replaced. When an agent's watcher replaces serve's, serve starts its own again a second later and the agent's watcher exits. That exit is what keeps the two quiet. If upstream makes a replaced watcher reconnect, they replace each other every second. After a Ryugi upgrade, check that a replaced watcher still stops (`Signal::Replaced` in upstream `hook/src/cmd.rs`) and watch `~/Library/Logs/ryugi-t3.log` for a restart loop.

## How we work

We like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to honor the dev's intent in both a minimal and realistic fashion.

The rest of this document is meant to help you navigate the codebase and make changes effectively. Think of these instructions less as "hard rules", more as "good defaults". The developer's preferences should be able to override anything here.

## A small glossary

We need to be on the same page with terminology. When communicating, use this language:

- **you** means the agent reading this file and changing this project.
- **we, us, and maintainers** mean the people building this project. These are who you are talking to now.
- **user** means the person using what this project ships.
- **hub** means the shared Ryugi server process. It detects new feedback and pushes it to the connection that holds each session.
- **subscription** means an entry in `~/.ryugi/server/agent-subscriptions.json`, keyed `host:session`. For T3 the session is the thread id.
- **Ryugi watcher** means a `ryugi-hook watch cmd` process. It holds one session's hub connection and runs the host command for each event. `ryugi start` spawns one from the agent's shell; in a Claude thread, T3 kills it when the Claude CLI exits.
- **serve** means `ryugi-t3 serve`, the launchd-owned process that keeps a Ryugi watcher running for every custom-host subscription.
- **receipt** means the `delivery` field that `t3 thread send` returns. Each of its four values, `started`, `queued`, `steered`, and `restarted`, means the thread accepted the message.

## Ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or `kill` a PID you found by matching a name, path, or worktree string. Your own agent process has this worktree's path in its argv, and this machine runs several other dev servers at once. Kill only a PID you captured at spawn, or the owner of your port after confirming its cwd is your worktree.
2. **Writing Ryugi's live state.** The hub owns `~/.ryugi/server/agent-subscriptions.json`, and `~/.config/ryugi/config.json` routes the feedback of every T3 thread. Read them only. Tests point `RYUGI_SERVER_HOME`, `RYUGI_HOSTS_CONFIG`, `RYUGI_HUB_SOCKET`, and `T3CODE_CLI_PATH` at temp dirs and fakes; new tests do the same.
3. **A second serve.** A serve started by hand next to the launchd job starts a second set of watchers, which the hub and the watchers' own lock files then sort out. Restart the job with `launchctl kickstart -k gui/$(id -u)/dev.ryugi-t3.serve` instead.
4. **Sending to a real thread.** `deliver.cjs` aimed at a real thread starts a real agent turn. Point `T3CODE_CLI_PATH` at the fake T3 CLI from `test/deliver.test.cjs`.

## Hit every surface

The most common defect is a change that works on the path you tested and is missing everywhere else. Before calling work done, walk this list and say which entries applied:

- **Entry points.** A behavior reachable from one place is usually also reachable from others. Fixing one is not fixing the feature.
- **Contracts.** Anything crossing a process or network boundary is typed in one place. Change the schema and every consumer follows.
- **Reverse states.** If you added a way in, add the way out and the way to see it. Snooze needs unsnooze. Close needs reopen. A one-way door is a bug.
- **Docs.** Check whether the change makes existing guidance inaccurate. Apply the [documentation rules](#documentation) before adding anything.

This project's surfaces:

- **Providers.** T3 sets `T3CODE_THREAD_ID` for Claude, Codex, Pi, and Antigravity threads, so all four reach this project. T3 terminals lack it, and `ryugi start` there subscribes under the native host.
- **Watcher owners.** A session's Ryugi watcher may come from serve or from `ryugi start` in the agent's shell. Both run `deliver.cjs`, so a change to it reaches both; a change to `serve.cjs` reaches only the watchers serve starts.
- **Ryugi installs.** serve takes the watcher binary from `~/.ryugi/hook/<version>/` for the newest plugin under `~/.local/share/ryugi/install/plugins/`. The Claude Code plugin is a separate copy under `~/.claude/plugins/cache/ryugi-dev/`; check its version with `claude plugin list` after an upgrade.

## Dev servers

The launchd job `dev.ryugi-t3.serve`, installed by `./launchd.sh`, is the one process meant to outlive a session; the maintainer asked for it. Its watchers keep the binary they started with; after a Ryugi upgrade, a watcher picks up the new binary the next time serve starts it.

- Stop what you started, by the PID you tracked. See "Killing by pattern".
- Run dev servers and builds from your own shell so they end with your session. Do not detach them with `systemd-run`, `nohup`, `setsid`, or `tmux` unless the user asks for one that outlives the session. Detached servers ran for weeks and filled RAM and swap.
- Need a second checkout? `git worktree add` it next to this worktree, not in `/tmp`. Remove it when done.

## Verifying

`npm test` runs the whole suite in about three seconds; run one file with `node --test test/serve.test.cjs`. The serve tests use a fake watcher and a fake hub. A broken restart makes a serve test hang, not fail. Run the suite in the background, capture its PID, and kill that PID if it is still running after 40 seconds.

- Test behavior that can break, such as orchestration, protocol translation, auth and permission guards, persistence and migrations, external-format parsing, race fixes, and the logic a bug fix changed. Leave out tests for what types already guarantee, trivial logic, copy text, smoke runs, mock-call mirrors, callback wiring, and props rendered to static markup.
- Extend before you add. When an existing test or table covers the behavior, add a row or an assertion there. Write a new test only when no case fits.
- Test at one layer: the lowest one that fails on `main`. Do not repeat the case in a wrapper test, at each call site, or in copies of the same logic.
- Backend behavior changes ship with focused tests for that behavior.
- Proof for a bug fix depends on the bug. Logic, data, state, and protocol bugs get a failing test first (the fewest that fail on `main` for that reason, in an existing case where one fits), then the fix. Purely visual bugs (spacing, colour, alignment, a layout shift) get before/after captures as their proof and no test. A server-only fix with no visible surface ships the test plus a short runtime transcript.
- Never wait on sleeps or polling. Await the event, promise, or queue item that marks the milestone. A test that needs a timeout to pass is wrong.
  - No per-test timeout argument or `retry`. Flaky tests are fixed, not retried.
  - No `performance.now()` or `Date.now()` deltas. Assert on events and counts, not elapsed time.
  - `it.skip` and friends need a tracking issue on the line above: `// quarantine: #1234 <why>`.
- Real agent turns cost money. Use a free replay or mock provider when one exists. Use a real provider only when the change depends on that provider's behavior, and then pick its cheapest model.

## Pull requests

- Never make a PR unless the developer explicitly asks you to do so.
- `origin` is not always GitHub. Check `git remote get-url origin` before your first forge command and use that forge's CLI and skill.
- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`.
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work.
- One request is one PR. Split it only when the maintainer asks.

## Documentation

Most code changes do not need an internal documentation change. Agents can read the code.

- Internal docs are for architectural decisions and their reasons, constraints that span components, and implementation traps that are hard to discover from the source. Before adding a paragraph, ask what a maintainer would get wrong without it. If reading the relevant code answers the question, leave it out.
- Do not document every feature, enumerate fields or methods, narrate control flow, maintain file catalogs, or append PR summaries. Types, tests, and code already record the implementation. The glossary defines shared vocabulary; it is not a feature index.
- A local reason the code can't show goes in a short nearby code comment. Use an internal doc when the reasoning crosses boundaries or needs context the code cannot carry well. Link to the relevant source instead of copying it.
- When a documented decision or constraint changes, rewrite or remove the affected text. Do not append another account of the new behavior. A new internal page needs a distinct, durable reason to exist.
- User docs help users accomplish tasks. Give each major feature a concise section explaining what it does, how to start, and anything unintuitive. A settings path is useful; descriptions of visible buttons, icons, layouts, animations, or every UI state are not. Before adding text, ask what task or decision it helps the user with.
- Keep user docs in the shipped product's voice, without implementation details or contributor tooling. Update the relevant feature section when how to use it changes. A UI tweak does not need a documentation entry, and a new control does not need its own page.
- Operations docs hold maintainer setup, release, and debugging procedures. Instructions for operating what users install belong in user docs.

## Plans and work artifacts

- Do not commit implementation plans, research notes, or agent scratch files. Keep temporary working material outside the worktree.
- Track active maintainer work in the issue or project item that owns it.
- A merged PR is the implementation record. Close or update its tracking item when the work lands; do not preserve a second checklist in the repository.

## How it works

`ryugi start` in a T3 thread writes the subscription `t3:<thread id>`. serve sees the subscriptions file change and starts `ryugi-hook watch cmd` for that session, passing the host, session, and project on stdin. The watcher reads the host command from Ryugi's config, starts the hub if it is down, and for each event runs `ryugi-t3`, which runs `deliver.cjs`, which sends the wake message with `t3 thread send`.

serve depends on three Ryugi internals, none of them a public API: the subscriptions file format, read only in `sync()`; the `ryugi-hook watch cmd` stdin contract; and the binary location with the two variables the watcher needs from serve, `RYUGI_PLUGIN_ROOT` and a `PATH` that has `node`, all in `hook()`. A Ryugi upgrade can break any of them.

## Taste

- Default to no comment. Write one only for a constraint, an external quirk, or an invariant the code can't show, in one line where you can and four at most. Don't restate names or signatures, narrate steps, record history, or explain the fix you just made; the PR carries that.
- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it.
- Plain CommonJS, no dependencies, no build step. Let Ryugi's own watcher do everything that speaks the hub protocol; serve only decides which watchers should be running.
- `deliver.cjs` is the lasting part. serve and `launchd.sh` exist only because the Ryugi watcher dies inside T3. Once Ryugi keeps custom-host watchers alive outside the agent's process tree, delete `serve.cjs`, `launchd.sh`, their tests, and the README section about them.

## Additional tips

- Security is important, but should not be over-indexed on, especially for dev mode/maintainer-only features.
