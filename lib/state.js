/**
 * Projection of the audit model onto the wire shape the panel consumes.
 *
 * The panel is a separate process boundary (browser, over HTTP), so everything
 * it needs has to be decided here rather than derived there — except filtering,
 * which is cheap and stays in the client so the filter buttons feel instant.
 *
 * Two rules carry over from the text report and matter more here, because a
 * table makes a wrong zero look authoritative:
 *
 * - a value that could not be read is `null`, never `0`;
 * - `deletable` is computed once, next to the reasons, so the UI never has to
 *   re-derive permission from a handful of flags.
 *
 * @module dsh-session-admin/state
 */

import { listTrash } from './trash.js'

/** A per-session decision the UI must not re-derive on its own. */
function deletionGate(session, services) {
  if (session.live === true) return { deletable: false, blockedReason: '会话正在运行（live）：先让它停下来再处理' }
  if (session.hasLog === false) return { deletable: false, blockedReason: '磁盘上没有这个会话的日志，无可移动的内容' }
  if (services.sessionQuery === undefined) {
    // Without live state this plugin cannot prove a session is idle. It refuses
    // rather than guess: moving a live session's log out from under its writer
    // is exactly how a transcript gets corrupted.
    return { deletable: false, blockedReason: 'sessionQuery 服务不可用，无法确认会话是否正在运行' }
  }
  return { deletable: true, blockedReason: null }
}

/**
 * Build the payload served at `GET /session-admin/state`.
 *
 * @param gathered - the result of `gather`.
 * @param options - `titles`, `maxRows`.
 * @returns the JSON-serializable state object.
 */
export function buildState(gathered, options = {}) {
  const { audit, home, notes, services } = gathered
  const titles = options.titles ?? new Map()

  const sessions = audit.largest.map((session) => {
    const gate = deletionGate(session, services)
    return {
      id: session.id,
      project: session.project,
      projectKey: session.projectKey ?? null,
      createdAt: session.createdAt ?? null,
      live: session.live ?? null,
      archived: session.archived === true,
      pinned: session.pinned === true,
      isSubagent: session.isSubagent ?? null,
      parentSession: session.parentSession ?? null,
      logBytes: session.logBytes,
      cacheBytes: session.cacheBytes,
      bytes: session.logBytes + session.cacheBytes,
      hasLog: session.hasLog === true,
      hasCache: session.hasCache === true,
      inWorkspaceAccount: session.inWorkspaceAccount === true,
      // Computed once in the audit over the whole corpus, so the same number
      // serves the text report and the panel's trash confirmation.
      descendants: session.descendants ?? 0,
      descendantBytes: session.descendantBytes ?? 0,
      title: titles.get(session.id) ?? null,
      deletable: gate.deletable,
      blockedReason: gate.blockedReason,
    }
  })

  const trash = listTrash(home)

  return {
    ok: true,
    generatedAt: audit.generatedAt,
    home,
    services: {
      sessionQuery: audit.services.sessionQuery,
      sessionPersistence: audit.services.sessionPersistence,
      workspaceRegistry: audit.services.workspaceRegistry,
    },
    corpus: {
      sessions: audit.corpus.sessions,
      logBytes: audit.corpus.logBytes,
      cacheBytes: audit.corpus.cacheBytes,
      archived: audit.corpus.archived,
      pinned: audit.corpus.pinned,
      live: audit.corpus.live ?? null,
      subagent: audit.corpus.subagent ?? null,
      subagentBytes: audit.corpus.subagentBytes ?? null,
      unaccounted: audit.corpus.unaccounted,
      workspaceRecords: audit.corpus.workspaceRecords,
    },
    projects: audit.projects,
    sessions,
    cascades: (audit.archivedCascades ?? []).map((row) => ({
      id: row.id,
      ownBytes: row.ownBytes,
      descendants: row.descendants,
      descendantBytes: row.descendantBytes,
      totalBytes: row.totalBytes,
    })),
    trash: {
      root: trash.root,
      bytes: trash.bytes,
      entries: trash.entries.map((entry) => ({
        id: entry.id,
        createdAt: entry.createdAt,
        sessions: entry.sessions.length,
        sessionIds: entry.sessionIds,
        bytes: entry.bytes,
        manifestMissing: entry.manifestMissing,
      })),
    },
    attachments: {
      objects: audit.attachments.objects,
      objectsBytes: audit.attachments.objectsBytes,
      staged: audit.attachments.staged,
      stagedBytes: audit.attachments.stagedBytes,
      deep: audit.attachments.deep === true,
      verified: audit.attachments.verified === true,
      candidates: audit.attachments.candidates,
      candidateBytes: audit.attachments.candidateBytes,
      candidateSample: audit.attachments.candidateSample ?? [],
    },
    warnings: [
      ...notes,
      ...audit.divergences.layoutWarnings,
      ...(audit.divergences.workspaceRegistryOk ? [] : [`workspace.json 不可读：${audit.divergences.workspaceRegistryError}`]),
      ...(gathered.referenceFailures ?? []).map((f) => `引用扫描失败 ${f.id}：${f.error}`),
    ],
  }
}

/**
 * The error shape every route returns, so the panel has exactly one to handle.
 *
 * @param message - human-readable reason, already localized where it matters.
 * @param action - the command that failed, when known.
 * @returns the JSON-serializable failure body.
 */
export const failureState = (message, action) => ({ ok: false, action: action ?? null, message, errors: [message], changed: 0, skipped: [] })
