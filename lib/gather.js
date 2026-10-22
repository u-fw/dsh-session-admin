/**
 * The read side, shared by every consumer.
 *
 * The tool and the HTTP route behind the panel must never see different
 * numbers, so both go through this one function and neither owns its own
 * scanning. It resolves the home, probes the three optional Host Services,
 * reads every filesystem surface, and folds the two together into one audit
 * model.
 *
 * @module dsh-session-admin/gather
 */

import { buildAudit, collectReferences } from './audit.js'
import {
  readFileIndexRefs,
  readWorkspaceState,
  resolveHome,
  scanAttachmentStore,
  scanProjectionCache,
  scanRequestImageCache,
  scanSessionLogs,
} from './scan.js'

/** Options every gather accepts; only `deep` changes the cost class. */
const DEFAULTS = { deep: false, graceMinutes: 60, olderThanDays: undefined }

/**
 * Collect one audit snapshot.
 *
 * @param ctx - plugin context; the three session services are probed, not required.
 * @param options - `home`, `deep`, `graceMinutes`, `olderThanDays`, `signal`.
 * @returns the audit model, the home, service availability, and human-readable notes.
 * @throws when no DSH home can be resolved, or when `deep` is asked for without the
 *   service that can decode logs — there is no safe degraded mode for either.
 */
export async function gather(ctx, options = {}) {
  const settings = { ...DEFAULTS, ...options }
  const notes = []
  const home = resolveHome(settings.home)
  if (home === undefined) {
    throw new Error(`no DSH home found; tried ${settings.home ?? '(none)'}, $DSH_HOME=${process.env.DSH_HOME ?? '(unset)'}, and ~/.dsh`)
  }

  const sessionQuery = ctx.get('sessionQuery')
  const sessionPersistence = ctx.get('sessionPersistence')
  const workspaceRegistry = ctx.get('workspaceRegistry')
  const sessionProjectionCache = ctx.get('sessionProjectionCache')
  if (sessionQuery === undefined) notes.push('sessionQuery 服务不可用：会话元数据（createdAt/cwd/live/父子关系）缺失，报告只反映磁盘。')
  if (sessionPersistence === undefined) notes.push('sessionPersistence 服务不可用：无法对照持久化列表，分歧检查不完整。')
  if (workspaceRegistry === undefined) notes.push('workspaceRegistry 服务不可用：无法对照运行中的工作区投影。')

  const signal = settings.signal
  const records = sessionQuery === undefined ? [] : await sessionQuery.listSessions(signal)
  const snapshots = sessionPersistence === undefined ? [] : await sessionPersistence.list({ signal })
  const registryWorkspaces = workspaceRegistry === undefined ? undefined : workspaceRegistry.list()

  const logs = scanSessionLogs(home)
  const cache = scanProjectionCache(home)
  const workspace = readWorkspaceState(home)
  const attachments = scanAttachmentStore(home)
  const requestImages = scanRequestImageCache(home)
  const fileIndex = readFileIndexRefs(home)

  let referencedAttachmentIds
  let referenceFailures = []
  if (settings.deep === true) {
    // A reference sweep is the precondition for every deletion, and only the
    // Host's own decoder can produce a trustworthy one. Without the service
    // there is no safe way to run it at all, so this refuses instead of
    // degrading into an unverified candidate list.
    if (sessionQuery === undefined) {
      throw new Error('deep=true 需要 sessionQuery 服务来读取会话日志；该服务不可用，因此无法做引用计数，也不会产出任何候选（这比给出未验证的清单更安全）。')
    }
    const ids = (records.length > 0 ? records : snapshots.map((s) => ({ header: s.header }))).map((r) => r.header.id)
    notes.push(`引用计数扫描：读取 ${ids.length} 个会话的日志。`)
    const sweep = await collectReferences(sessionQuery, ids, signal)
    referencedAttachmentIds = sweep.referenced
    referenceFailures = sweep.failures
    if (referenceFailures.length > 0) {
      notes.push(`${referenceFailures.length} 个会话读取失败，其引用未被计入；这些失败会使回收更保守，不会更激进。`)
    }
  }

  const audit = buildAudit({
    home,
    scan: {
      logs,
      cache,
      workspace,
      attachments,
      requestImages,
      fileIndex,
      referencedAttachmentIds,
      deep: settings.deep === true,
      graceMs: settings.graceMinutes * 60_000,
      olderThanMs: settings.olderThanDays === undefined ? undefined : settings.olderThanDays * 86_400_000,
    },
    records,
    snapshots,
    registryWorkspaces,
    // Absent services are recorded, not defaulted: a zero that means "unread"
    // and a zero that means "none found" must not look the same in a report
    // that someone is about to delete files based on.
    services: {
      sessionQuery: sessionQuery !== undefined,
      sessionPersistence: sessionPersistence !== undefined,
      workspaceRegistry: workspaceRegistry !== undefined,
    },
  })
  audit.referenceFailures = referenceFailures

  return {
    audit,
    home,
    notes,
    referenceFailures,
    services: { sessionQuery, sessionPersistence, workspaceRegistry, sessionProjectionCache },
    records,
  }
}

/**
 * Zero-I/O titles from the persisted projection cache.
 *
 * Reading real titles means folding each session's log, which is the expensive
 * operation this plugin deliberately keeps off the default path. The projection
 * cache already holds the folded value, keyed by the header the caller already
 * has, so the panel can label rows without one decode per session. A session
 * with no cache entry simply gets no title.
 *
 * @param sessionProjectionCache - the Host's projection cache service, or undefined.
 * @param headers - session headers to look up.
 * @returns a map from session id to title for whichever sessions have one.
 */
export function readCachedTitles(sessionProjectionCache, headers) {
  const titles = new Map()
  if (sessionProjectionCache === undefined) return titles
  for (const header of headers) {
    try {
      const snapshot = sessionProjectionCache.cachedSnapshot(header, ['title'])
      const title = snapshot?.values?.title
      if (typeof title === 'string' && title !== '') titles.set(header.id, title)
      else if (typeof title?.title === 'string' && title.title !== '') titles.set(header.id, title.title)
    } catch {
      // A cache miss or a shape change costs a label, never the whole panel.
    }
  }
  return titles
}
