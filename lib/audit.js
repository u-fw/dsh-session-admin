/**
 * Join the filesystem scan with the Host's own view of the session corpus, and
 * decide what a cleanup WOULD remove.
 *
 * Nothing in this module mutates anything. Its job is to disagree loudly when
 * the two views of the corpus diverge — a log with no cache entry, a cache entry
 * with no log, a session no workspace accounts for — because those divergences
 * are exactly what makes a "clean up the archived sessions" instruction
 * ambiguous.
 *
 * Reloading note: under a profile with `hmr.config.root: []` (the stock default)
 * Node caches this module by URL and no edit here takes effect without a
 * restart. See README.zh.md, "开发与重载".
 *
 * @module dsh-session-admin/audit
 */

import { collectAttachmentIds } from './scan.js'

/** Normalize a cwd for comparison; Windows paths are case-insensitive. */
const normalizeCwd = (cwd) => (typeof cwd === 'string' ? cwd.replace(/[\\/]+$/, '').toLowerCase() : undefined)

/**
 * Build the full audit model.
 *
 * @param input - resolved home, scanned surfaces, and the Host's session views.
 * @param input.home - resolved DSH home.
 * @param input.scan - result of the `scan.js` readers.
 * @param input.records - `sessionQuery.listSessions()` records, when available.
 * @param input.snapshots - `sessionPersistence.list()` snapshots, when available.
 * @param input.registryWorkspaces - `workspaceRegistry.list()` projection, when available.
 * @param input.services - which Host Services answered; absent ones make their
 *   columns unknowable, and an unknowable column is reported as such rather than
 *   as a zero that reads like a finding.
 * @param input.now - clock, injectable for tests.
 * @returns a JSON-serializable audit model.
 */
export function buildAudit({ home, scan, records, snapshots, registryWorkspaces, services = {}, now = Date.now() }) {
  const hasQuery = services.sessionQuery === true
  const hasPersistence = services.sessionPersistence === true
  const { logs, cache, workspace, attachments, requestImages, fileIndex } = scan

  const logById = new Map(logs.sessions.map((s) => [s.id, s]))
  const cacheById = new Map(cache.entries.map((e) => [e.id, e]))
  const recordById = new Map((records ?? []).map((r) => [r.header.id, r]))
  const snapshotById = new Map((snapshots ?? []).map((s) => [s.header.id, s]))

  const archived = new Set(workspace.archivedIds)
  const pinned = new Set(workspace.pinnedIds)

  const accountById = new Map()
  /** Workspace paths, for resolving a session's cwd to its owning registration. */
  const workspaceByPath = new Map()
  for (const ws of workspace.workspaces) {
    const key = normalizeCwd(ws.path)
    if (key !== undefined) workspaceByPath.set(key, ws)
    for (const id of ws.sessionIds) {
      if (!accountById.has(id)) accountById.set(id, [])
      accountById.get(id).push(ws.id)
    }
  }

  // A session is identified by having a log or a header from a Service. A
  // projection-cache file alone is not a session — it is a leftover of one — so
  // it is excluded here and reported only as a cache orphan. Counting it as a
  // session would inflate the total, the unaccounted set, and the byte totals
  // with something that cannot be opened at all.
  const realIds = new Set([...logById.keys(), ...recordById.keys(), ...snapshotById.keys()])
  const cacheOnlyIds = cache.entries.filter((entry) => !realIds.has(entry.id)).map((entry) => entry.id)

  const sessions = []
  for (const id of realIds) {
    const log = logById.get(id)
    const header = recordById.get(id)?.header ?? snapshotById.get(id)?.header
    const cwd = header?.cwd
    const owningWorkspace = cwd === undefined ? undefined : workspaceByPath.get(normalizeCwd(cwd))
    const accountWorkspaces = accountById.get(id) ?? []
    sessions.push({
      id,
      project: typeof cwd === 'string' ? cwd : (log?.project ?? '(unknown project)'),
      projectKey: log?.projectKey,
      cwd,
      createdAt: header?.createdAt,
      live: hasQuery ? recordById.get(id)?.live ?? false : undefined,
      persisted: hasPersistence ? snapshotById.has(id) : undefined,
      archived: archived.has(id),
      pinned: pinned.has(id),
      isSubagent: header === undefined ? undefined : header.origin === 'subagent' || header.parentSession !== undefined,
      parentSession: header?.parentSession,
      delegationDepth: header?.delegationDepth,
      logBytes: log?.bytes ?? 0,
      cacheBytes: cacheById.get(id)?.bytes ?? 0,
      // Internal, for the action layer only: `state.js` projects an explicit
      // field list, so these never reach the browser.
      dir: log?.dir,
      cachePath: cacheById.get(id)?.path,
      hasLog: log !== undefined,
      hasCache: cacheById.has(id),
      inWorkspaceAccount: accountWorkspaces.length > 0,
      workspaceIds: accountWorkspaces,
      workspaceForCwd: owningWorkspace?.id,
      eventCount: snapshotById.get(id)?.eventCount,
    })
  }
  sessions.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))

  const bytesOf = (list) => list.reduce((sum, s) => sum + s.logBytes + s.cacheBytes, 0)
  const logBytesOf = (list) => list.reduce((sum, s) => sum + s.logBytes, 0)

  /**
   * A session is unaccounted for when no workspace lists it AND its cwd belongs
   * to no registered workspace. Such a session cannot be reached from the
   * sidebar, yet it still occupies its full log. A delegation child is excluded
   * even though it is normally unlisted: it is reachable through its parent, so
   * counting it here would inflate the number that matters.
   */
  const unaccounted = sessions.filter((s) => !s.inWorkspaceAccount && s.workspaceForCwd === undefined && s.isSubagent !== true)
  const archivedSessions = sessions.filter((s) => s.archived)
  const pinnedSessions = sessions.filter((s) => s.pinned)
  const liveSessions = sessions.filter((s) => s.live === true)
  const subagentSessions = sessions.filter((s) => s.isSubagent === true)
  const unaccountedIds = new Set(unaccounted.map((s) => s.id))

  const byProject = new Map()
  for (const session of sessions) {
    const key = session.projectKey ?? session.project
    if (!byProject.has(key)) {
      byProject.set(key, { key, project: session.project, sessions: 0, bytes: 0, archived: 0, unaccounted: 0, live: 0 })
    }
    const row = byProject.get(key)
    row.sessions += 1
    row.bytes += session.logBytes + session.cacheBytes
    if (session.archived) row.archived += 1
    if (unaccountedIds.has(session.id)) row.unaccounted += 1
    if (session.live === true) row.live += 1
  }

  const attachmentAnalysis = analyzeAttachments({
    attachments,
    indexRefs: fileIndex.ids,
    referenced: scan.referencedAttachmentIds ?? new Set(),
    deep: scan.deep === true,
    now,
    graceMs: scan.graceMs ?? 60 * 60 * 1000,
    olderThanMs: scan.olderThanMs,
  })

  annotateDescendants(sessions)
  const archivedCascades = buildCascades(archivedSessions)

  return {
    home,
    generatedAt: now,
    services: {
      sessionQuery: hasQuery,
      sessionPersistence: hasPersistence,
      workspaceRegistry: Array.isArray(registryWorkspaces),
    },
    corpus: {
      sessions: sessions.length,
      logBytes: logBytesOf(sessions),
      cacheBytes: sessions.reduce((sum, s) => sum + s.cacheBytes, 0),
      archived: { count: archivedSessions.length, bytes: bytesOf(archivedSessions) },
      pinned: pinnedSessions.length,
      live: hasQuery ? liveSessions.length : undefined,
      subagent: hasQuery ? subagentSessions.length : undefined,
      subagentBytes: hasQuery ? bytesOf(subagentSessions) : undefined,
      unaccounted: { count: unaccounted.length, bytes: bytesOf(unaccounted) },
      workspaceRecords: workspace.workspaces.length,
    },
    projects: [...byProject.values()].sort((a, b) => b.bytes - a.bytes),
    archivedSessions,
    archivedCascades,
    pinnedSessions,
    largest: [...sessions].sort((a, b) => b.logBytes - a.logBytes),
    divergences: {
      workspaceRegistryOk: workspace.ok,
      workspaceRegistryError: workspace.error,
      // Filesystem-only comparisons: valid with or without Host Services.
      cacheWithoutLog: cacheOnlyIds,
      logWithoutCache: sessions.filter((s) => s.hasLog && !s.hasCache).map((s) => s.id),
      unaccounted: unaccounted.map((s) => s.id),
      archivedWithoutLog: archivedSessions.filter((s) => !s.hasLog).map((s) => s.id),
      pinnedWithoutLog: pinnedSessions.filter((s) => !s.hasLog).map((s) => s.id),
      layoutWarnings: logs.warnings,
      // These two need `sessionPersistence`; without it they are unknowable, and
      // an empty array would read as "no divergence found". `null` is used
      // rather than leaving the field absent, because the result crosses a JSON
      // boundary that drops `undefined` — which would make "could not read" and
      // "read, found nothing" the same value to any consumer of the payload.
      logWithoutPersistence: hasPersistence ? sessions.filter((s) => s.hasLog && s.persisted !== true).map((s) => s.id) : null,
      persistenceWithoutLog: hasPersistence ? sessions.filter((s) => s.persisted === true && !s.hasLog).map((s) => s.id) : null,
      registryAccountMismatch: compareRegistry(workspace, registryWorkspaces),
    },
    attachments: attachmentAnalysis,
    requestImageCache: requestImages,
    fileIndex: { ok: fileIndex.ok, path: fileIndex.path, records: fileIndex.records, error: fileIndex.error },
  }
}

/**
 * Annotate every session with the size of its delegation subtree.
 *
 * This is the one finding that changes what "clean up the archived sessions"
 * means. Archiving a parent does not touch its children, and a child normally
 * has no workspace accounting of its own — it is reachable only through its
 * parent. Delete the parent log alone and those children stop being reachable
 * by anything, while still occupying their full size on disk. On a real corpus
 * 6 of 10 archived sessions had children, 38 in total, so deleting "the
 * archived sessions" without deciding what happens to their subtrees leaves
 * exactly the kind of orphan the cleanup was meant to remove.
 *
 * Computed for every session, not only archived ones: the panel needs the same
 * figure to ask the right question before quarantining anything, and two
 * independent lineage walks would eventually disagree.
 *
 * @param sessions - every session in the corpus; annotated in place.
 */
function annotateDescendants(sessions) {
  const childrenByParent = new Map()
  const sizeById = new Map()
  const byId = new Map()
  for (const session of sessions) {
    sizeById.set(session.id, session.logBytes + session.cacheBytes)
    byId.set(session.id, session)
    if (session.parentSession === undefined) continue
    if (!childrenByParent.has(session.parentSession)) childrenByParent.set(session.parentSession, [])
    childrenByParent.get(session.parentSession).push(session.id)
  }

  for (const session of sessions) {
    // Breadth-first over the subtree, with a seen-set so a malformed lineage
    // cannot spin forever and a cycle cannot double-count.
    const seen = new Set()
    const queue = [...(childrenByParent.get(session.id) ?? [])]
    let descendantBytes = 0
    while (queue.length > 0) {
      const id = queue.shift()
      if (seen.has(id)) continue
      seen.add(id)
      descendantBytes += sizeById.get(id) ?? 0
      queue.push(...(childrenByParent.get(id) ?? []))
    }
    const row = byId.get(session.id)
    row.descendants = seen.size
    row.descendantBytes = descendantBytes
  }
}

/**
 * The archived sessions' cascade rows, derived from the per-session annotation.
 *
 * @param archived - the subset currently in the archive set.
 * @returns one row per archived session that has descendants, largest subtree first.
 */
function buildCascades(archived) {
  return archived
    .filter((session) => (session.descendants ?? 0) > 0)
    .map((session) => ({
      id: session.id,
      ownBytes: session.logBytes + session.cacheBytes,
      descendants: session.descendants,
      descendantBytes: session.descendantBytes,
      totalBytes: session.logBytes + session.cacheBytes + session.descendantBytes,
    }))
    .sort((a, b) => b.descendants - a.descendants)
}

/**
 * Compare the durable accounting slots with the live registry projection.
 *
 * `workspace.json` stores the slots a session was attached to, while
 * `Workspace.sessionIds` is documented as filtered by the canonical-cwd header
 * index. The two therefore disagree whenever a session's recorded cwd no longer
 * matches its workspace — which is precisely the case where deleting "the
 * sessions this workspace lists" would delete something else than expected.
 *
 * @param fileState - parsed `workspace.json` view.
 * @param registryWorkspaces - `workspaceRegistry.list()` result, when available.
 * @returns per-workspace differences, or undefined when the registry is absent.
 */
function compareRegistry(fileState, registryWorkspaces) {
  if (!Array.isArray(registryWorkspaces)) return undefined
  const live = new Map(registryWorkspaces.map((ws) => [ws.id, new Set(ws.sessionIds ?? [])]))
  const rows = []
  for (const ws of fileState.workspaces) {
    const projected = live.get(ws.id)
    if (projected === undefined) {
      rows.push({ workspace: ws.id, title: ws.title, issue: 'absent-from-registry', stored: ws.sessionIds.length, projected: 0 })
      continue
    }
    const hidden = ws.sessionIds.filter((id) => !projected.has(id))
    if (hidden.length > 0) rows.push({ workspace: ws.id, title: ws.title, issue: 'hidden-by-cwd-filter', stored: ws.sessionIds.length, projected: projected.size, hidden })
  }
  for (const ws of registryWorkspaces) {
    if (!fileState.workspaces.some((stored) => stored.id === ws.id)) {
      rows.push({ workspace: ws.id, title: ws.title, issue: 'absent-from-file', stored: 0, projected: (ws.sessionIds ?? []).length })
    }
  }
  return rows
}

/**
 * Decide which attachment objects nothing references any more.
 *
 * Three independent reasons keep an object, and each is reported separately so a
 * surprising number can be traced to the rule that produced it:
 *
 * 1. a surviving session still refers to it (only knowable from `deep` scans);
 * 2. the provider file index still lists it, expired or not;
 * 3. it is younger than the grace window, so a request may be in flight.
 *
 * @param input - store contents, reference sets, and policy windows.
 * @returns counts and the reclaimable candidate list.
 */
export function analyzeAttachments({ attachments, referenced, indexRefs, deep, now, graceMs, olderThanMs }) {
  const objects = attachments.objects ?? []
  const keptReferenced = []
  const keptIndexed = []
  const keptYoung = []
  const candidates = []
  const shape = {
    root: attachments.root,
    objects: objects.length,
    objectsBytes: attachments.objectsBytes ?? objects.reduce((sum, o) => sum + o.bytes, 0),
    staged: (attachments.staged ?? []).length,
    stagedBytes: attachments.stagedBytes ?? 0,
    layoutAnomalies: attachments.layoutAnomalies ?? [],
  }

  // Without a verified reference set there is no candidate list at all. The
  // grace window would otherwise be the only thing standing between an
  // unverified sweep and a delete, and "we never looked" must not be
  // representable as "nothing references it".
  if (deep !== true) {
    return {
      ...shape,
      deep: false,
      verified: false,
      referencedIds: undefined,
      indexedIds: indexRefs.size,
      kept: { referenced: undefined, indexed: undefined, youngerThanGrace: undefined },
      candidates: 0,
      candidateBytes: 0,
      candidateSample: [],
      candidatePaths: [],
    }
  }

  for (const object of objects) {
    if (referenced.has(object.id)) {
      keptReferenced.push(object.id)
      continue
    }
    if (indexRefs.has(object.id)) {
      keptIndexed.push(object.id)
      continue
    }
    if (now - object.mtimeMs < graceMs) {
      keptYoung.push(object.id)
      continue
    }
    if (olderThanMs !== undefined && now - object.mtimeMs < olderThanMs) continue
    candidates.push(object)
  }

  return {
    ...shape,
    deep,
    verified: true,
    referencedIds: referenced.size,
    indexedIds: indexRefs.size,
    kept: { referenced: keptReferenced.length, indexed: keptIndexed.length, youngerThanGrace: keptYoung.length },
    candidates: candidates.length,
    candidateBytes: candidates.reduce((sum, o) => sum + o.bytes, 0),
    candidateSample: candidates
      .slice()
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 25)
      .map((o) => ({ id: o.id, bytes: o.bytes, ageDays: Math.floor((now - o.mtimeMs) / 86_400_000) })),
    candidatePaths: candidates.map((o) => o.path),
  }
}

/**
 * Collect the attachment ids referenced by the sessions that are being kept.
 *
 * A session's own events are the only authoritative record of what it uses, so
 * this reads them through the Host's query service rather than parsing logs.
 * Each observation is a lease and is released immediately; leaking one pins the
 * whole parsed log in the query cache.
 *
 * @param sessionQuery - the Host's `sessionQuery` service.
 * @param ids - session ids whose references should be counted.
 * @param signal - cancellation for the whole sweep.
 * @returns referenced ids plus per-session failures.
 */
export async function collectReferences(sessionQuery, ids, signal) {
  const referenced = new Set()
  const failures = []
  for (const id of ids) {
    let observation
    try {
      observation = await sessionQuery.observeSession(id, { projectionMode: 'none', signal })
      collectAttachmentIds(observation.events, referenced)
    } catch (error) {
      failures.push({ id, error: error?.message ?? String(error) })
    } finally {
      releaseObservation(observation)
    }
  }
  return { referenced, failures }
}

/**
 * Release one observation lease.
 *
 * `SessionObservation` implements the explicit-resource-management protocol, so
 * the disposer is `[Symbol.dispose]()` and not a `.dispose()` method. A
 * `observation.dispose?.()` call therefore compiles, runs, and silently leaks:
 * the query service's cache is small, and a pinned entry is never evicted, so
 * one leaked lease per session would hold the entire parsed corpus in memory.
 * `.dispose` is still tried as a fallback for any wrapper that adds one.
 *
 * @param observation - the lease to release, possibly undefined.
 * @returns true when a disposer actually ran.
 */
export function releaseObservation(observation) {
  if (observation === null || observation === undefined) return false
  const viaSymbol = observation[Symbol.dispose]
  if (typeof viaSymbol === 'function') {
    try {
      viaSymbol.call(observation)
      return true
    } catch {
      // Fall through to the method form before giving up.
    }
  }
  if (typeof observation.dispose === 'function') {
    try {
      observation.dispose()
      return true
    } catch {
      return false
    }
  }
  return false
}
