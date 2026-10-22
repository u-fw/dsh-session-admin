# Contributing

The maintainer- and contributor-facing companion to [README.md](README.md) / [README.zh.md](README.zh.md). It covers the two things a *user* of the plugin does not need: how a code change reaches a running DSH, and how to keep identifying detail out of the repository. What the tests are and how to run them is documented once, in the README's test section.

## Development loop

The two halves reload differently:

| What changed | How it takes effect |
|---|---|
| `lib/client.js` (client half) | **A page refresh is enough.** client-modules re-reads the file, hands out a new rev, and the browser reloads that bundle |
| host-half modules (`lib/index.js` and everything it imports) | **Only if the profile watches modules.** Otherwise DSH must be restarted |

Module watching is opt-in: dsh-base ships `hmr.config.root: []`, so a stock profile hot-reloads configuration and never code. See the README's "Development and reloading" for the override and for why `base` must be an absolute `file://` URL.

Two traps, both measured rather than reasoned about:

- **HMR only reacts to changes it observed after it started watching.** Files already on disk when `root` is opened produce no change event, so they are never re-imported. If an edit does not take effect, force one further change through that file before concluding the reload is broken.
- **A reload can produce a mixed generation** — a new entry module paired with cached dependencies. For a plugin that moves files this is worse than not reloading at all: if a leaf edit produces no behaviour change, assume the running code differs from disk and restart. Do not debug a destructive path against a generation you cannot identify.

Disabling and re-enabling the plugin in **Settings → Plugins** is *not* a substitute for a restart — it re-runs `apply` on the module generation already in memory.

## Keeping identifying detail out of the repository

There is no automated leak guard in this repository yet, so the discipline is manual. It still matters: a plugin repository is where an installation's private structure leaks most easily.

- **No real home directories or workspace paths.** Examples use placeholders (`/path/to/your/plugin-checkouts/`, `C:/work/alpha`). A real path in a README is as public as one in code.
- **No real session ids, titles, or corpus figures pasted from a machine.** Aggregate numbers in the README are either rounded to obviously-synthetic values or explicitly attributed to "one real corpus" without the raw totals. A real total plus a real project name fingerprints an installation even without a username.
- **Fixtures use neutral placeholders.** Every test fixture here builds its own temp `DSH home` and invents ids (`sess-1`, `--proj--`); keep it that way.
- **Never commit a `.dsh` directory, a profile config, or a session log** — `.gitignore` covers the first two, and the third must simply never be staged.

Before pushing anything that touches prose, examples, or fixtures, grep the tracked tree:

```bash
git grep -n -I -E 'C:/User[s]/|/User[s]/|/hom[e]/' HEAD
```

The character classes are deliberate: they match real home-directory paths but not this line itself, so a clean run really is clean.

## Commit style

One-line imperative subject, blank line, then a body explaining what changed and why. The initial commit on `main` is the reference for the expected level of detail.

While the repository is young enough that nobody has forked it, the maintainer has amended the initial commit and force-pushed, to keep the published history to a single clean commit. Stop doing that as soon as there are forks or external contributions: rewriting published history breaks anyone who has fetched.
