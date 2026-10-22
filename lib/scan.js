/**
 * Filesystem side of the audit: everything about a DSH installation that no Host
 * Service exposes.
 *
 * DSH deliberately has no "delete a session" capability. Archiving only adds an
 * id to `workspace.json`'s global archive set, and nothing in the Service
 * catalog lists that set, reports on-disk session sizes, or enumerates the
 * content-addressed attachment store. This module reads those surfaces directly
 * and reports what it found instead of assuming the layout is intact, so a
 * format change degrades into a warning rather than a wrong number.
 *
 * Every function here is read-only and synchronous: an audit runs inside one
 * tool call and needs a consistent snapshot, not streaming.
 *
 * @module dsh-session-admin/scan
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Whether a directory looks like a DSH home: it must hold the two roots this
 * plugin reads. Cheap and side-effect free, used to reject a wrong `DSH_HOME`
 * instead of silently reporting an empty installation.
 *
 * @param path - candidate home directory.
 * @returns true when `sessions/` or `storages/` exists under it.
 */
export function looksLikeHome(path) {
  return existsSync(join(path, 'sessions')) || existsSync(join(path, 'storages'))
}

/**
 * Resolve the DSH home to audit.
 *
 * An explicit override is honored or refused, never quietly replaced: a caller
 * that asked for one installation must not receive a confident report about
 * another. Only when no override is given does resolution fall back through
 * `DSH_HOME` to `~/.dsh`, and every candidate must look like a home, so a stale
 * environment variable cannot become a report about nothing.
 *
 * @param explicit - caller-supplied home, if any.
 * @returns the resolved home, or undefined when the request cannot be honored.
 */
export function resolveHome(explicit) {
  if (typeof explicit === 'string' && explicit !== '') return looksLikeHome(explicit) ? explicit : undefined
  const candidates = []
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '') candidates.push(process.env.DSH_HOME)
  candidates.push(join(homedir(), '.dsh'))
  for (const candidate of candidates) {
    if (looksLikeHome(candidate)) return candidate
  }
  return undefined
}

/** Read a directory's entries, treating a missing or unreadable directory as empty. */
function readDirSafe(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
  } catch {
    return []
  }
}

/** Recursively total one directory: file count and byte count. */
function measureDir(path) {
  let files = 0
  let bytes = 0
  for (const entry of readDirSafe(path)) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) {
      const nested = measureDir(child)
      files += nested.files
      bytes += nested.bytes
      continue
    }
    if (!entry.isFile()) continue
    try {
      bytes += statSync(child).size
      files += 1
    } catch {
      // A file that vanished mid-scan contributes nothing; it is not an error.
    }
  }
  return { files, bytes }
}

/**
 * Label a project directory for a report.
 *
 * The directory name is a lossy encoding of the session's `cwd`: DSH replaces
 * both `\` and `:` with `-`, so `deepseek-harness\default-workspace` and a path
 * that literally contained `deepseek\harness` encode identically. Decoding is
 * therefore impossible in general, and a "decoded" path is a plausible lie. The
 * key is returned verbatim; a caller that has session headers should prefer the
 * recorded `cwd`.
 *
 * @param projectKey - the `sessions/` subdirectory name.
 * @returns the key, unchanged.
 */
export function projectLabel(projectKey) {
  return projectKey
}

/**
 * Enumerate every session directory on disk.
 *
 * The layout is `<home>/sessions/<projectKey>/<sessionId>/`, and the directory
 * name is the authoritative storage identity. Sizes come from the filesystem
 * rather than `sessionPersistence.sizeBytes`, because an unmaterialized draft
 * reports no size there while its directory may still hold bytes.
 *
 * @param home - resolved DSH home.
 * @returns one record per session directory, plus layout warnings.
 */
export function scanSessionLogs(home) {
  const root = join(home, 'sessions')
  const sessions = []
  const warnings = []
  for (const project of readDirSafe(root)) {
    if (!project.isDirectory()) {
      warnings.push(`unexpected file directly under sessions/: ${project.name}`)
      continue
    }
    const projectDir = join(root, project.name)
    for (const entry of readDirSafe(projectDir)) {
      const path = join(projectDir, entry.name)
      if (!entry.isDirectory()) {
        warnings.push(`unexpected file inside ${project.name}/: ${entry.name}`)
        continue
      }
      const measured = measureDir(path)
      sessions.push({
        id: entry.name,
        projectKey: project.name,
        project: projectLabel(project.name),
        dir: path,
        files: measured.files,
        bytes: measured.bytes,
      })
    }
  }
  return { sessions, warnings }
}

/**
 * Enumerate the persisted projection cache.
 *
 * One `<sessionId>.json` per session. It is a derived read-model copy, so an
 * entry for a session whose log is gone is dead weight, and a missing entry only
 * costs a cold replay.
 *
 * @param home - resolved DSH home.
 * @returns one record per cache file.
 */
export function scanProjectionCache(home) {
  const root = join(home, 'storages', 'session_projcache', 'sessions')
  const entries = []
  for (const entry of readDirSafe(root)) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const path = join(root, entry.name)
    let bytes = 0
    try {
      bytes = statSync(path).size
    } catch {
      continue
    }
    entries.push({ id: entry.name.slice(0, -'.json'.length), path, bytes })
  }
  return { root, entries }
}

/**
 * Read the durable workspace registry that owns the archive and pin sets.
 *
 * This is the only place those two sets exist; no Service exposes them. Parsing
 * failure is reported as `ok: false` with the reason, because treating a corrupt
 * registry as "nothing archived" would be a confident lie.
 *
 * @param home - resolved DSH home.
 * @returns the archive set, pin set, workspace records, and parse status.
 */
export function readWorkspaceState(home) {
  const path = join(home, 'storages', 'workspace.json')
  if (!existsSync(path)) return { ok: false, path, error: 'workspace.json not found', archivedIds: [], pinnedIds: [], workspaces: [] }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return { ok: false, path, error: `workspace.json is not valid JSON: ${error.message}`, archivedIds: [], pinnedIds: [], workspaces: [] }
  }
  const global = parsed?.global ?? {}
  const table = parsed?.tables?.workspaces ?? {}
  const workspaces = Object.entries(table).map(([id, record]) => ({
    id,
    title: record?.title ?? '(untitled)',
    path: record?.path,
    sessionIds: Array.isArray(record?.sessionIds) ? [...record.sessionIds] : [],
  }))
  return {
    ok: true,
    path,
    version: parsed?.unit?.version,
    archivedIds: Array.isArray(global.archivedSessionIds) ? [...global.archivedSessionIds] : [],
    pinnedIds: Array.isArray(global.pinnedSessionIds) ? [...global.pinnedSessionIds] : [],
    workspaces,
  }
}

/** Recursively collect files under a directory, keyed by relative path. */
function walkFiles(root, prefix = '') {
  const out = []
  for (const entry of readDirSafe(join(root, prefix))) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      out.push(...walkFiles(root, rel))
      continue
    }
    if (!entry.isFile()) continue
    try {
      const info = statSync(join(root, rel))
      out.push({ rel, bytes: info.size, mtimeMs: info.mtimeMs })
    } catch {
      // Skip entries that disappeared mid-scan.
    }
  }
  return out
}

/**
 * Enumerate the immutable attachment store.
 *
 * Objects are content addressed: `objects/<first 2 hex>/<full 64 hex>`, and the
 * reference carried in session events is `sha256:<that same 64 hex>`. The
 * directory split is verified per object rather than trusted, so a changed
 * fan-out shows up as `layoutAnomalies` instead of silently mis-keying every id.
 *
 * @param home - resolved DSH home.
 * @returns objects, their total size, and any naming anomalies.
 */
export function scanAttachmentStore(home) {
  const root = join(home, 'attachments', 'v1')
  const objectsRoot = join(root, 'objects')
  const objects = []
  const layoutAnomalies = []
  for (const entry of walkFiles(objectsRoot)) {
    const slash = entry.rel.indexOf('/')
    const dir = slash === -1 ? '' : entry.rel.slice(0, slash)
    const name = slash === -1 ? entry.rel : entry.rel.slice(slash + 1)
    const wellFormed = slash !== -1 && /^[0-9a-f]{64}$/.test(name) && dir === name.slice(0, 2)
    if (!wellFormed) layoutAnomalies.push(entry.rel)
    objects.push({
      id: `sha256:${name}`,
      rel: entry.rel,
      path: join(objectsRoot, entry.rel),
      bytes: entry.bytes,
      mtimeMs: entry.mtimeMs,
      wellFormed,
    })
  }
  const staged = walkFiles(join(root, 'tmp'))
  return {
    root,
    objects,
    objectsBytes: objects.reduce((sum, o) => sum + o.bytes, 0),
    staged,
    stagedBytes: staged.reduce((sum, o) => sum + o.bytes, 0),
    layoutAnomalies,
  }
}

/** Measure the regenerable request-image cache DSH keeps outside the store. */
export function scanRequestImageCache(home) {
  const root = join(home, 'cache', 'attachments', 'request-images')
  const files = walkFiles(root)
  return { root, files: files.length, bytes: files.reduce((sum, f) => sum + f.bytes, 0) }
}

/**
 * Read the provider-side attachment index.
 *
 * `files-v3.json` maps stored attachments and their derived variants to the ids
 * a provider was told about, with expiries. GC must treat every id in here as
 * live regardless of expiry, because an expired record can still describe a
 * request that has not been retried yet.
 *
 * @param home - resolved DSH home.
 * @returns referenced ids and whether the index could be read.
 */
export function readFileIndexRefs(home) {
  const path = join(home, 'llm-deepseek', 'files-v3.json')
  if (!existsSync(path)) return { ok: false, path, ids: new Set(), records: 0 }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const ids = new Set()
    for (const record of parsed?.records ?? []) {
      for (const key of ['attachmentId', 'variantId']) {
        if (typeof record?.[key] === 'string') ids.add(record[key])
      }
    }
    return { ok: true, path, ids, records: (parsed?.records ?? []).length }
  } catch (error) {
    return { ok: false, path, ids: new Set(), records: 0, error: error.message }
  }
}

/**
 * Collect every attachment id a JSON value refers to.
 *
 * Deliberately generic: any string of the `sha256:<64 hex>` shape anywhere in a
 * session's events counts as a reference. Over-retention is safe here and exact
 * block-shape matching is not, because a log may carry ids inside tool
 * arguments, `meta` payloads, or future block variants this plugin cannot know.
 *
 * @param value - any JSON-derived value.
 * @param into - set to add discovered ids to.
 * @returns the same set, for chaining.
 */
export function collectAttachmentIds(value, into = new Set()) {
  if (typeof value === 'string') {
    if (/^sha256:[0-9a-f]{64}$/.test(value)) into.add(value)
    return into
  }
  if (value === null || typeof value !== 'object') return into
  if (Array.isArray(value)) {
    for (const item of value) collectAttachmentIds(item, into)
    return into
  }
  for (const nested of Object.values(value)) collectAttachmentIds(nested, into)
  return into
}
