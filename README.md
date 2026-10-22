# dsh-session-admin — session storage audit and management for DSH

A DeepSeek Harness plugin that reports what a session corpus actually occupies on disk, and puts the operations you would want next behind that report: archive, pin, quarantining, attachment reclamation.

It ships as two halves. The host half registers the `session_admin` tool plus a pair of same-origin JSON routes. The client half renders a management panel in the main column, a sidebar icon, and a Settings page.

> **One principle runs through the whole thing: be able to check before acting.**
> DSH archives a session by adding an id to `workspace.json`'s archive set, and does nothing else — the log file is untouched. No Service can list that set, and none can delete a session. So "clean up the archived sessions" has no API to call and no single source of truth to consult. This plugin builds a report you can audit first, then offers operations on top of it. Removal itself is reversible (see [Trash](#removal-is-reversible)).

## What it answers

- What archived sessions really occupy (log + projection cache), and whether they are still alive.
- **How many delegation children an archived session carries.** This is the finding that changes what "cleanup" means. Archiving does not touch a session's children, and a child normally has no workspace accounting of its own — it is reachable only through its parent. Removing the parent's log strands every descendant while the bytes stay on disk. On one real corpus **6 of 10 archived sessions carried children, 38 in total**, roughly doubling what "the archived sessions" actually occupy.
- **What share of the corpus is delegation children.** Easy to mistake for orphaned work when only the filesystem is visible: on that same corpus **116 of 139 sessions were subagent children** (`origin: 'subagent'`, `delegationDepth: 1`), about **62% of log bytes**, against 23 top-level sessions.
- Which sessions are genuinely unreachable from the sidebar — not in any workspace's `sessionIds`, whose `cwd` maps to no registered workspace, and **not** a delegation child.
- Where the on-disk corpus and the live `sessionPersistence` / `workspaceRegistry` views disagree. Those disagreements are exactly where a cleanup goes wrong.
- Which attachment objects nothing references any more, and how much that reclaims.

## Requirements

- A DSH installation that provides `plugin_manager` (the desktop or web app), and a checkout of this repository.
- Node.js ≥ 22.15 for the standalone CLI and the tests. DSH supplies its own runtime for the plugin itself.
- No runtime dependencies. The plugin uses only services on `ctx` and Node built-ins.

## Install

Two equivalent paths:

- **Plugin manager** — have the agent call `plugin_manager`'s `install_bundle` with this directory as the target, or use **Settings → Plugins** in the Web UI.
- **Manual** — add this directory as a dependency of the profile (the package manager records it as `link:`), then list it in the profile `package.json`'s `dsh.profile.bundles`.

Registration is two declarations. The profile `link:`s to this directory, so the checkout is what loads. `package.json`'s `dsh.bundle.patch` points at `cordis.patch.yml`, which inserts exactly one row for the host half. The client half needs no row of its own: the module scanner finds it through `dsh.client` and `exports["./client"]`, and serves it as part of the same plugin. Both declarations must stay in `package.json`, and `exports["./client"]` must point at a file that exists — otherwise the panel silently never loads.

## The tool

Once installed, a model can call `session_admin`:

| Parameter | Default | Meaning |
| --- | --- | --- |
| `action` | `report` | `report` audits session storage; `attachments` audits the attachment store |
| `home` | `$DSH_HOME` → `~/.dsh` | DSH home to audit. A candidate that does not look like a home is rejected rather than producing a confident report about nothing |
| `limit` | `15` | Maximum rows per list |
| `full` | `false` | List every row |
| `deep` | `false` | `attachments` only: read every session log to count real references |
| `gc` | `false` | `attachments` only: actually delete unreferenced objects (requires `deep` and `confirm`) |
| `confirm` | `false` | Explicit confirmation for `gc`; without it `gc` only reports |
| `graceMinutes` | `60` | Objects modified within this window are never collected |
| `olderThanDays` | — | Only consider objects idle at least this many days |

It also runs outside DSH. The host half reaches for its three session services through `ctx.get(...)`, so with none of them present the report states which columns are unknown instead of filling in zeros:

```bash
DSH_HOME=~/.dsh node tools/audit.mjs                 # read-only session audit
DSH_HOME=~/.dsh node tools/audit.mjs --action attachments --deep
DSH_HOME=~/.dsh node tools/audit.mjs --full --json
```

## The panel

Three registrations, all keyed by the same id (`session-admin`):

| Where | Slot | Role |
| --- | --- | --- |
| Sidebar icon | `sidebar.panellist` | Opens the panel in the main column |
| Main panel | `main` (its `key` must equal that id) | The full management surface |
| Settings page | `settings.section` | The same content as a settings entry |

It browses sessions grouped by project (size, created time, archived / pinned / live / subagent / unaccounted markers), filters, selects in bulk to archive and pin, **quarantines** sessions, restores them, empties the trash, and scans for and reclaims unreferenced attachment objects.

### Data channel

A pair of same-origin JSON routes rather than a generated Remote, so the client half needs no code generation and no DSH-internal import:

```
GET  /session-admin/state     -> full state (per-session size, markers, descendant counts, trash, attachments)
POST /session-admin/action    -> { action, ... }; returns message / skipped / errors **and the new state**
```

The new state comes back with the command, so the panel never has to re-fetch and can never show a stale table after a successful write.

### Removal is reversible

This is the most important design decision in the plugin. DSH has no session-delete API, so deleting is a raw filesystem operation against an append-only log — irreversible, with no transaction to lean on. So the panel's delete does not delete:

- the session is **moved** into `<home>/session-admin-trash/<entry>/` (a same-volume `rename`: atomic, no data rewritten);
- restoring moves it back; only "empty trash" destroys bytes, and that needs a second confirmation;
- the trash sits **beside** `sessions/`, not inside it. `session-persistence-jsonl` enumerates `<projectKey>/<sessionId>` under its single configured root, so a quarantined session is invisible to every Host scanner — it cannot be listed, resumed, or indexed while it waits.

Two guards: restoring **never overwrites** an existing session with the same id (ids can be recreated; overwriting would destroy the newer log to resurrect the older one), and every session is re-checked for `live` state and log existence right before the move. Failures are reported per session rather than failing the batch.

### Confirmation rules

Quarantining, attachment reclamation, and emptying the trash each require an inline two-step confirmation (not `window.confirm`) that states what will happen and how many bytes are involved. **A session that carries children must be resolved explicitly** — "only these" or "together with N children" — and never defaults silently to including them.

## Where a session lives in a DSH installation

| Path | Content | When deleting |
| --- | --- | --- |
| `<home>/sessions/<projectKey>/<sessionId>/session.v4.jsonl.zstd` | The session log | Must go, or the corpus still contains the session |
| `<home>/storages/session_projcache/sessions/<sessionId>.json` | Projection cache (derived) | Must go; leaving only this produces a cache orphan |
| `<home>/storages/workspace.json` | `global.archivedSessionIds`, `global.pinnedSessionIds`, per-workspace `sessionIds` | Archive and pin ids must be dropped, or they dangle |
| `<home>/attachments/v1/objects/<first-2-hex>/<64-hex>` | Content-addressed attachment objects, **shared across sessions** | Cannot be removed per session; only a reference count over the surviving corpus can reclaim them |
| `<home>/cache/attachments/request-images/**` | Regenerable request-image cache | Safe to clear wholesale; unrelated to any session |

`projectKey` is a **lossy** encoding of `cwd` — both `\` and `:` become `-`, so `deepseek-harness\default-workspace` and a path literally containing `deepseek\harness` encode identically. Decoding is therefore impossible in general, and this plugin never attempts it: it uses the recorded `cwd` from a session header whenever one is available.

### Why it does not parse logs itself

`session.v4.jsonl.zstd` is not a single zstd stream. It is an append-only container of **plaintext and zstd frames interleaved**: `zstdDecompressSync` and the streaming decoder both yield only the first frame (measured: a 2.36 MB file decodes to a 243-byte header). The format is private and will change, and a wrong reference count directly causes attachments to be deleted while still in use. So reference counting goes through `ctx.sessionQuery.observeSession()` and lets DSH decode. Each observation is a lease and is released immediately — the query service's cache is small and a pinned entry is never evicted.

## Development and reloading

Short version: **HMR can hot-reload the host half, but only once module watching is opted in.** Out of the box a profile hot-reloads configuration and never code.

dsh-base ships `hmr.config.root: []` deliberately, with the comment "Profile configuration reloads by default; module roots are opt-in". `root: []` means no module file is watched, so Node's ESM-by-URL cache keeps every module at its first-loaded generation, and each host-half edit costs a restart. Disabling and re-enabling the plugin in **Settings → Plugins** is *not* a substitute — it re-runs `apply` on the generation already in memory.

To opt in, override `hmr` in `cordis.patch.yml` (whose header says "Edit cordis.patch.yml, not this file"):

```yaml
- id: hmr
  config:
    base: file:///path/to/your/plugin-checkouts/
    root:
      - dsh-session-admin
      - another-plugin-you-are-developing
```

`base` must be an absolute `file://` URL rather than a relative path, because this entry is declared inside the dsh-base bundle and its `baseUrl` is not your profile's. Keep `root` to the plugin checkouts you actually edit; pointing it at a whole workspace only adds watch noise.

### Two traps worth knowing

**HMR only reacts to changes it observed after it started watching.** Opening `root` does not re-import files that were already on disk — they generate no change event. Measured: after enabling `root`, editing only `lib/index.js` (adding a visible marker) made the marker appear while earlier edits to `lib/report.js` / `lib/audit.js` did *not* take effect. Forcing one change through each of those files made both apply.

**A mixed generation is worse than no reload.** If a leaf module changes and then the entry module changes, the reload can leave you with a new entry paired with cached dependencies. For a plugin that moves files, that is not a state to debug in: if a leaf edit produces no behaviour change, assume the running code differs from disk and restart rather than keep investigating.

## Two hard constraints

Neither is a style preference; both are "looks right, fails silently" traps, each pinned by a test.

### 1. A tool result must be lossless JSON

The Host rejects a tool result that cannot round-trip through JSON with `tool "..." returned invalid output: value is not lossless JSON` — **the entire result is discarded**, so not one word of the report reaches the model.

The lethal part is the trigger condition: the optional field `divergences.workspaceRegistryError` is absent exactly when the registry is *healthy*, and `JSON.stringify` silently drops `undefined` properties. The commonest path — everything is fine — was the broken one, and the CLI printing text never showed it. `runAudit` therefore passes its whole value through `losslessJson()`, and `test/run-audit.test.mjs` asserts `JSON.parse(JSON.stringify(value))` deep-equals `value`.

### 2. Releasing a session lease takes `[Symbol.dispose]()`

`SessionObservation` implements explicit resource management, so its disposer is `[Symbol.dispose]()`; there is **no** `.dispose()` method. Writing `observation.dispose?.()` throws nothing and does nothing. The query service's cache is small and pinned entries are never evicted, so one leaked lease pins an entire parsed corpus in memory.

`releaseObservation()` calls the symbol first and falls back to `.dispose`, returning whether a disposer actually ran. The fake observation in the tests implements **only** the symbol method, because a fake that also had `.dispose()` would let a real leak pass.

## Safety boundaries

Three write surfaces, each with its own precondition:

| Write | Precondition | Reversible? |
| --- | --- | --- |
| Archive / pin | Through `workspaceRegistry`, which validates session existence itself | Yes |
| Quarantine | Per-session re-check of `live` and log existence; **refuses** rather than guesses when `sessionQuery` is unavailable | **Yes** (restorable) |
| Attachment reclamation | Requires `deep` **and** `confirm`; path containment re-checked before each removal | No (but the object was unreferenced) |
| Empty trash | Requires `confirm` | No |

Also:

- Without a reference sweep there is **no candidate list at all** — "never looked" must not be expressible as "nothing references it".
- The three retention reasons are counted separately so an odd number can be traced to a rule: referenced by a surviving session / listed in the provider file index (expired or not) / inside the grace window.
- A value that could not be read renders as unknown, never as `0`.
- Every write reports what changed, how many bytes, and which entries were skipped and why.

## Tests

```bash
npm test
```

68 tests, all synthetic fixtures, no real DSH home required. Every path that needs a Host service injects a fake `sessionQuery` / `sessionPersistence` / `workspaceRegistry`; the write path builds a fake DSH home in a temp directory and really moves files.

They focus on the places that "look right, destroy data when run": the lossless-JSON boundary, lease release, restore-never-overwrites, attachment path containment, and the distinction between unknown and zero.

### Running tests inside a sandbox

`node --test` spawns a child process per test file and captures its piped output. In a sandbox that forbids named pipes (for example DSH's `workspace-write` file policy) that step fails with `EPERM`. Two ways out:

```bash
# Node 24+: in-process isolation, no child processes
npm run test:in-process

# Or run in an unrestricted shell
npm test
```

The second is the only one available on Node 22: `--test-isolation` is a Node 24 flag.

## Composition

```
dsh-session-admin/
├── package.json          # dsh.bundle.patch + dsh.client declarations
├── cordis.patch.yml      # one row: the host half
├── lib/
│   ├── index.js          # entry: tool registration, argument validation, the two routes
│   ├── gather.js         # the single read path (shared by the tool and the panel)
│   ├── scan.js           # filesystem scanning (read-only)
│   ├── audit.js          # join with session services, lineage annotation, reclaimability, leases
│   ├── state.js          # the wire projection the panel consumes, plus deletion gating
│   ├── actions.js        # command execution: archive/pin/trash/attachment collection
│   ├── trash.js          # quarantine: same-volume rename, restore, empty
│   ├── report.js         # text report rendering + lossless JSON sanitising
│   └── client.js         # client half: main panel, sidebar icon, Settings page
├── test/                 # scan / audit / report / args / full-path / write-path
└── tools/audit.mjs       # the same audit, runnable without DSH
```

Zero runtime dependencies: only services on `ctx` and Node built-ins (`node:fs` / `node:os` / `node:path`). That is deliberate — the plugin is installed into a profile through `link:`, so resolving DSH-internal packages from a checkout is not reliable, while the services on `ctx` are a stable contract.

## Known limits

- **The report is a point-in-time snapshot of the filesystem and does not see DSH's internal write queue.** Write commands re-check `live`, but no such check can eliminate the window between check and move.
- **The archive set in `workspace.json` is not exposed by any Service**, so it is read from the file directly. A corrupt registry reports `ok: false` with the reason rather than pretending nothing is archived.
- **`Workspace.sessionIds` and the file's `sessionIds` can disagree**: the former is filtered through the canonical-cwd header index. The difference is listed on its own, because it is precisely the case where "delete what this workspace lists" deletes the wrong thing.
- **The trash never expires on its own.** Quarantined sessions keep occupying disk until restored or emptied. That is intentional — automatic deletion would hide an irreversible operation.
- Attachment reference scanning is O(total log bytes); a cold read of a large corpus takes seconds to tens of seconds.
- Report and panel text are currently Chinese-only.

## License

MIT
