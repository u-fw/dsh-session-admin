/**
 * Host half of `dsh-session-admin`: one read-first tool over a DSH
 * installation's session corpus.
 *
 * Why this exists: DSH archives a session by adding its id to
 * `workspace.json`'s global archive set, and nothing else. No Service can delete
 * a session, no Service exposes the archive set, and no Service reports on-disk
 * sizes — so "clean up the archived sessions" has no API to call and no single
 * place to look. This plugin reports every surface a session occupies, flags the
 * cases where the durable registry and the session corpus disagree, and counts
 * attachment references that survive because content-addressed blobs are shared.
 *
 * The first version deliberately deletes nothing. Session removal is a
 * filesystem operation with no transactional owner, so the report has to be
 * trustworthy before anything acts on it. The one exception is the attachment
 * store, whose unreferenced objects are unreachable by construction — and even
 * that requires an explicit `gc: true, confirm: true`.
 *
 * @module dsh-session-admin
 */

import { executeCommand, collectAttachmentObjects } from './actions.js'
import { gather, readCachedTitles } from './gather.js'
import { formatBytes, losslessJson, renderAudit } from './report.js'
import { buildState } from './state.js'
import {
  readFileIndexRefs,
  readWorkspaceState,
  resolveHome,
  scanAttachmentStore,
  scanProjectionCache,
  scanRequestImageCache,
  scanSessionLogs,
} from './scan.js'

/** Cordis plugin name. */
export const name = 'session-admin'

/**
 * The tool registry and the browser carrier are both required.
 *
 * `webServer` has to be declared, not reached for: `ctx.webServer` is undefined
 * until the service is injected, so registering a route without this would throw
 * inside the effect and take the tool down with it.
 */
export const inject = ['tools', 'webServer']

/** The single model-facing tool this plugin registers. */
export const TOOL_NAME = 'session_admin'

const ACTIONS = ['report', 'attachments']
const DEFAULT_LIMIT = 15
const DEFAULT_GRACE_MINUTES = 60

/** JSON Schema the model's arguments are checked against. */
const PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: [...ACTIONS],
      description: 'report (session storage audit, read-only) | attachments (attachment store audit, and with gc+confirm, reclamation).',
    },
    home: {
      type: 'string',
      description: 'DSH home to audit. Defaults to $DSH_HOME, then ~/.dsh.',
    },
    limit: {
      type: 'integer',
      description: `Maximum rows per list (default ${DEFAULT_LIMIT}).`,
    },
    full: {
      type: 'boolean',
      description: 'List every row instead of the first `limit`.',
    },
    deep: {
      type: 'boolean',
      description: 'For action=attachments: read every session log to count real references. Costs one full corpus read.',
    },
    gc: {
      type: 'boolean',
      description: 'For action=attachments: delete the unreferenced objects. Requires deep and confirm.',
    },
    confirm: {
      type: 'boolean',
      description: 'Explicit confirmation for gc. Without it, gc only reports.',
    },
    graceMinutes: {
      type: 'integer',
      description: `Objects modified within this window are never collected (default ${DEFAULT_GRACE_MINUTES}).`,
    },
    olderThanDays: {
      type: 'integer',
      description: 'For action=attachments: only consider objects idle for at least this many days.',
    },
  },
  additionalProperties: false,
}

/** JSON Schema of what `execute` resolves to. */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'The rendered report.' },
    home: { type: 'string' },
    action: { type: 'string' },
    sessions: { type: 'integer' },
    archivedSessions: { type: 'integer' },
    unaccountedSessions: { type: 'integer' },
    logBytes: { type: 'integer' },
    cacheBytes: { type: 'integer' },
    attachmentObjects: { type: 'integer' },
    attachmentBytes: { type: 'integer' },
    attachmentCandidates: { type: 'integer' },
    attachmentCandidateBytes: { type: 'integer' },
    deletedObjects: { type: 'integer' },
    deletedBytes: { type: 'integer' },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['text', 'home', 'action'],
  additionalProperties: true,
}

/**
 * Narrow and validate the model's arguments.
 *
 * `additionalProperties: false` already rejects unknown keys at the schema
 * boundary, but this plugin writes raw JSON Schema instead of DSH's compiled
 * spec form, so it owns its own checks and fails loud on nonsense rather than
 * defaulting to something destructive.
 *
 * @param args - raw tool arguments.
 * @returns normalized options.
 */
export function normalizeArgs(args) {
  const raw = args ?? {}
  const action = raw.action ?? 'report'
  if (!ACTIONS.includes(action)) throw new Error(`unknown action ${JSON.stringify(action)}; expected one of ${ACTIONS.join(', ')}`)
  const limit = raw.limit ?? DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('limit must be an integer between 1 and 500')
  const graceMinutes = raw.graceMinutes ?? DEFAULT_GRACE_MINUTES
  if (!Number.isInteger(graceMinutes) || graceMinutes < 0) throw new Error('graceMinutes must be a non-negative integer')
  if (raw.olderThanDays !== undefined && (!Number.isInteger(raw.olderThanDays) || raw.olderThanDays < 0)) throw new Error('olderThanDays must be a non-negative integer')
  if (raw.gc === true && raw.deep !== true) throw new Error('gc requires deep: true — refuse to collect on an unverified reference set')
  if (raw.gc === true && raw.confirm !== true) throw new Error('gc requires confirm: true')
  return {
    action,
    home: raw.home,
    limit,
    full: raw.full === true,
    deep: raw.deep === true,
    gc: raw.gc === true,
    confirm: raw.confirm === true,
    graceMinutes,
    olderThanDays: raw.olderThanDays,
  }
}

/**
 * Run one audit.
 *
 * @param ctx - plugin context; `sessionQuery`/`sessionPersistence`/`workspaceRegistry` are probed.
 * @param options - normalized options from `normalizeArgs`.
 * @param signal - cancellation for session reads.
 * @returns the tool value: rendered text plus the headline numbers.
 */
export async function runAudit(ctx, options, signal) {
  const deep = options.action === 'attachments' && options.deep
  const { audit, home, notes } = await gather(ctx, {
    home: options.home,
    deep,
    graceMinutes: options.graceMinutes,
    olderThanDays: options.olderThanDays,
    signal,
  })

  let deletedObjects = 0
  let deletedBytes = 0
  let gcRan = false
  let actionSummary = '只读审计。没有删除、没有归档、没有改动 workspace.json。'
  if (options.action === 'attachments' && options.gc && options.confirm && deep) {
    gcRan = true
    // The container check lives in `collectAttachmentObjects` so the tool and
    // the panel cannot drift apart on the one thing guarding a delete.
    const removed = collectAttachmentObjects(audit)
    deletedObjects = removed.deletedObjects
    deletedBytes = removed.deletedBytes
    notes.push(...removed.errors)
    actionSummary = deletedObjects === 0
      ? '回收已获授权，但候选清单为空：没有删除任何对象。会话日志、投影缓存、workspace.json 均未改动。'
      : `已删除 ${deletedObjects} 个无引用附件对象，回收 ${formatBytes(deletedBytes)}。会话日志、投影缓存、workspace.json 均未改动。`
  } else if (options.action === 'attachments' && options.gc) {
    actionSummary = 'gc 被请求但未执行（缺少 deep 或 confirm）。只读。'
  }

  const text = renderAudit(audit, {
    limit: options.limit,
    full: options.full,
    gcRan,
    gcApplied: deletedObjects > 0,
    actionSummary,
  })

  // Everything the report body could not place: service availability, sweep
  // failures, and any disagreement between the durable registry and its live
  // projection. These are the lines that change how much the report is trusted.
  const footnotes = [...notes]
  for (const row of audit.divergences.registryAccountMismatch ?? []) {
    if (row.issue === 'hidden-by-cwd-filter') {
      footnotes.push(`工作区「${row.title}」登记了 ${row.stored} 个会话，运行中的投影只认 ${row.projected} 个；被 cwd 索引挡住的 ${row.hidden.length} 个 id 见完整报告。`)
    } else {
      footnotes.push(`工作区「${row.title}」（${row.workspace}）：${row.issue}。`)
    }
  }
  const notesBlock = footnotes.length === 0 ? '' : `\n\n附注：\n${footnotes.map((n) => `- ${n}`).join('\n')}`

  // The Host rejects a tool result that cannot round-trip through JSON, and
  // `divergences` carries optional fields (`workspaceRegistryError`) that are
  // absent precisely when everything is healthy. Sanitizing here — at the single
  // boundary the value crosses — is what keeps a healthy installation from being
  // the case that silently returns nothing.
  return losslessJson({
    text: text + notesBlock,
    home,
    action: options.action,
    sessions: audit.corpus.sessions,
    archivedSessions: audit.corpus.archived.count,
    unaccountedSessions: audit.corpus.unaccounted.count,
    logBytes: audit.corpus.logBytes,
    cacheBytes: audit.corpus.cacheBytes,
    attachmentObjects: audit.attachments.objects,
    attachmentBytes: audit.attachments.objectsBytes,
    attachmentCandidates: audit.attachments.candidates,
    attachmentCandidateBytes: audit.attachments.candidateBytes,
    deletedObjects,
    deletedBytes,
    notes,
    divergences: audit.divergences,
  })
}

/**
 * Routes the panel half talks to.
 *
 * A same-origin HTTP JSON pair rather than a generated Remote, following the
 * sibling plugin in this workspace: the client half then needs no code
 * generation and no DSH-internal import, and the payload is the same audit the
 * tool renders.
 */
export const STATE_PATH = '/session-admin/state'
export const ACTION_PATH = '/session-admin/action'

/** Largest accepted request body; every command is a short JSON object. */
const MAX_BODY_BYTES = 64 * 1024

/** Write one JSON response with no caching, since every call is a fresh scan. */
function respond(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** Read a bounded JSON body, rejecting anything larger or malformed. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(new Error(`request body is not valid JSON: ${error.message}`))
      }
    })
  })
}

/** Build the panel state through the shared read path. */
async function panelState(ctx, url) {
  const deep = url.searchParams.get('deep') === '1'
  const gathered = await gather(ctx, { deep })
  return buildState(gathered, {
    titles: readCachedTitles(gathered.services.sessionProjectionCache, (gathered.records ?? []).map((r) => r.header)),
  })
}

/**
 * Register the tool and the panel's two routes.
 *
 * @param ctx - context carrying the tool registry and the web carrier.
 */
export function apply(ctx) {
  ctx.effect(
    () => ctx.tools.register({
      name: TOOL_NAME,
      description: 'Audit this DSH installation\'s session storage: on-disk session logs, the projection cache, the durable workspace registry\'s archive and pin sets, and the content-addressed attachment store. Read-only unless attachment GC is explicitly confirmed; DSH itself has no session-delete API, so this reports what a cleanup would touch instead of performing one.',
      parameters: PARAMETERS,
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      execute: (args, exec) => runAudit(ctx, normalizeArgs(args), exec.signal),
      isConcurrencySafe: () => true,
      presentCall: (args) => ({
        card: 'generic',
        title: args?.action === 'attachments' ? '审计附件仓库' : '审计会话存储',
        kind: 'read',
      }),
    }),
    'session-admin: tool',
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: STATE_PATH,
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          respond(res, 405, { ok: false, message: 'method not allowed' })
          return
        }
        try {
          respond(res, 200, await panelState(ctx, new URL(req.url ?? STATE_PATH, 'http://127.0.0.1')))
        } catch (error) {
          // A failed scan is reported as a state the panel can render, so the
          // panel never has to tell "empty installation" from "read failed".
          respond(res, 200, { ok: false, message: error?.message ?? String(error) })
        }
      },
    }),
    'session-admin: state route',
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: ACTION_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          respond(res, 405, { ok: false, message: 'method not allowed' })
          return
        }
        let command
        try {
          command = await readJsonBody(req)
        } catch (error) {
          respond(res, 400, { ok: false, action: null, changed: 0, skipped: [], errors: [error.message], message: error.message })
          return
        }
        try {
          const result = await executeCommand(ctx, command)
          if (result.state === undefined) {
            // Commands that did not need a corpus scan still owe the panel fresh
            // state, so it never renders a stale table after a successful write.
            result.state = await panelState(ctx, new URL(STATE_PATH, 'http://127.0.0.1'))
          }
          delete result.gathered
          respond(res, 200, result)
        } catch (error) {
          respond(res, 200, { ok: false, action: command?.action ?? null, changed: 0, skipped: [], errors: [error?.message ?? String(error)], message: error?.message ?? String(error) })
        }
      },
    }),
    'session-admin: action route',
  )

  ctx.logger?.info?.('session-admin: registered %s, %s and %s', TOOL_NAME, STATE_PATH, ACTION_PATH)
}
