/**
 * Run the audit from a plain shell, outside DSH.
 *
 * The plugin's own value comes from DSH Services (`sessionQuery`,
 * `sessionPersistence`, `workspaceRegistry`), but the filesystem half — log
 * sizes, the projection cache, the durable archive set, the attachment store —
 * needs none of them. This entry point therefore exercises the same code path
 * with every Service absent, which is both a useful standalone report and the
 * check that the plugin degrades honestly instead of inventing data.
 *
 * Usage: node tools/audit.mjs [--action report|attachments] [--deep] [--gc --confirm]
 *                             [--limit N] [--full] [--home PATH]
 *                             [--grace-minutes N] [--older-than-days N] [--json]
 */

import { normalizeArgs, runAudit } from '../lib/index.js'

/** Parse the flags this tool accepts; unknown flags fail loud. */
function parse(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    switch (flag) {
      case '--action': options.action = argv[++i]; break
      case '--home': options.home = argv[++i]; break
      case '--limit': options.limit = Number(argv[++i]); break
      case '--grace-minutes': options.graceMinutes = Number(argv[++i]); break
      case '--older-than-days': options.olderThanDays = Number(argv[++i]); break
      case '--deep': options.deep = true; break
      case '--gc': options.gc = true; break
      case '--confirm': options.confirm = true; break
      case '--full': options.full = true; break
      case '--json': options.json = true; break
      default: throw new Error(`unknown flag ${flag}`)
    }
  }
  return options
}

const parsed = parse(process.argv.slice(2))
const value = await runAudit({ get: () => undefined }, normalizeArgs(parsed), undefined)

if (parsed.json) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
} else {
  process.stdout.write(`${value.text}\n`)
}
