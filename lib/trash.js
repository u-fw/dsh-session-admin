/**
 * Quarantine engine: the reversible half of "delete a session".
 *
 * DSH has no session-delete API at all, so removal is a raw filesystem
 * operation on an append-only log — irreversible by construction and with no
 * transaction to lean on. A plain `rm` in a UI is therefore not acceptable:
 * one mis-click destroys a transcript that cannot be reconstructed.
 *
 * So nothing is ever deleted on the first action. A session is *moved* into
 * `<home>/session-admin-trash/<entryId>/`, which is a `rename` on the same
 * volume (atomic, and no data is rewritten). Restoring moves it back. Only
 * emptying the trash removes bytes, and that is a separate, explicitly
 * confirmed action.
 *
 * The trash root is a sibling of `sessions/`, never inside it:
 * `session-persistence-jsonl` enumerates `root/<projectKey>/<sessionId>` from a
 * single configured root, so a directory beside `sessions/` is invisible to
 * every scanner in the Host — the quarantined sessions cannot be listed,
 * resumed, or indexed while they wait.
 *
 * @module dsh-session-admin/trash
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Directory under the DSH home holding quarantined sessions. */
export const TRASH_DIRNAME = 'session-admin-trash'

/** Manifest filename inside each trash entry. */
const MANIFEST = 'manifest.json'

/** Absolute trash root for a DSH home. */
export const trashRoot = (home) => join(home, TRASH_DIRNAME)

/** Total bytes of a directory tree, tolerating entries that vanish mid-scan. */
function measure(dir) {
  let bytes = 0
  let files = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = measure(child)
      bytes += nested.bytes
      files += nested.files
      continue
    }
    try {
      bytes += statSync(child).size
      files += 1
    } catch {
      // A vanished file contributes nothing.
    }
  }
  return { bytes, files }
}

/**
 * Move one path, falling back to copy-then-remove across volumes.
 *
 * `rename` is atomic within a volume and rewrites nothing, which is what makes
 * quarantine cheap and safe. `EXDEV` means the trash landed on another volume
 * (a relocated DSH home, a mounted drive); there the copy must complete before
 * the source is touched, so a failure mid-copy leaves the original intact.
 *
 * @param from - existing source path.
 * @param to - destination path whose parent must already exist.
 */
function moveAcross(from, to) {
  try {
    renameSync(from, to)
    return
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
  }
  cpSync(from, to, { recursive: true, force: false, errorOnExist: true })
  rmSync(from, { recursive: true, force: true })
}

/** Read one entry's manifest, or undefined when it is missing or unreadable. */
export function readManifest(entryDir) {
  const path = join(entryDir, MANIFEST)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Every trash entry with what the UI needs to offer a restore.
 *
 * An entry whose manifest is unreadable is still listed, flagged
 * `manifestMissing`, because hiding it would hide real bytes and a real
 * restorable directory behind a corrupt metadata file.
 *
 * @param home - resolved DSH home.
 * @returns entries newest-first, plus the total quarantined size.
 */
export function listTrash(home) {
  const root = trashRoot(home)
  if (!existsSync(root)) return { root, entries: [], bytes: 0 }
  const entries = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    const manifest = readManifest(dir)
    let bytes = 0
    try {
      bytes = measure(dir).bytes
    } catch {
      // An unreadable entry still gets listed with zero measured bytes.
    }
    entries.push({
      id: entry.name,
      dir,
      createdAt: manifest?.createdAt ?? null,
      sessions: Array.isArray(manifest?.sessions) ? manifest.sessions : [],
      sessionIds: Array.isArray(manifest?.sessions) ? manifest.sessions.map((s) => s.id) : [],
      manifestMissing: manifest === undefined,
      bytes,
    })
  }
  entries.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  return { root, entries, bytes: entries.reduce((sum, e) => sum + e.bytes, 0) }
}

/**
 * Quarantine sessions: move each session directory and its projection cache
 * into one new trash entry.
 *
 * Only paths that were located by the caller's own scan are touched — this
 * function never derives a path from an id, so a malformed id cannot escape the
 * store. Each session is moved independently and failures are collected rather
 * than thrown, because a partial quarantine is still a valid outcome the UI can
 * report and the user can retry.
 *
 * @param home - resolved DSH home.
 * @param sessions - `{ id, dir, cachePath }` for each session to quarantine.
 * @param options - `stamp` for the entry id, injectable for tests.
 * @returns the entry id, what moved, and what failed.
 */
export function quarantine(home, sessions, options = {}) {
  const stamp = options.stamp ?? Date.now()
  const suffix = options.suffix ?? Math.random().toString(36).slice(2, 8)
  const entryId = `${stamp}-${suffix}`
  const entryDir = join(trashRoot(home), entryId)
  const moved = []
  const errors = []

  mkdirSync(join(entryDir, 'sessions'), { recursive: true })
  mkdirSync(join(entryDir, 'projcache'), { recursive: true })

  for (const session of sessions) {
    if (!existsSync(session.dir)) {
      errors.push(`session directory is gone: ${session.id}`)
      continue
    }
    const destination = join(entryDir, 'sessions', session.projectKey ?? '_unknown', session.id)
    try {
      mkdirSync(join(entryDir, 'sessions', session.projectKey ?? '_unknown'), { recursive: true })
      // A destination that already exists would mean two sessions sharing an id
      // inside one entry; refuse rather than merge two transcripts.
      if (existsSync(destination)) throw new Error('destination already exists')
      moveAcross(session.dir, destination)
      const record = { id: session.id, projectKey: session.projectKey ?? null, bytes: session.bytes ?? 0 }
      if (typeof session.cachePath === 'string' && existsSync(session.cachePath)) {
        const cacheDestination = join(entryDir, 'projcache', `${session.id}.json`)
        try {
          moveAcross(session.cachePath, cacheDestination)
          record.cacheMoved = true
        } catch (error) {
          // The log is quarantined; a stuck cache file is reported, not fatal.
          record.cacheMoved = false
          errors.push(`projection cache not moved for ${session.id}: ${error.message}`)
        }
      }
      moved.push(record)
    } catch (error) {
      errors.push(`${session.id}: ${error.message}`)
    }
  }

  if (moved.length === 0) {
    // Nothing moved: remove the optimistic shell instead of leaving an empty
    // entry that the UI would offer to restore.
    rmSync(entryDir, { recursive: true, force: true })
    return { entryId: null, entryDir: null, moved, errors, bytes: 0 }
  }

  const bytes = moved.reduce((sum, s) => sum + (s.bytes ?? 0), 0)
  writeFileSync(join(entryDir, MANIFEST), `${JSON.stringify({ entryId, createdAt: stamp, sessions: moved, bytes }, null, 2)}\n`)
  return { entryId, entryDir, moved, errors, bytes }
}

/**
 * Count what a trash entry still holds.
 *
 * Counted structurally rather than by top-level entries: restoring the last
 * session out of an entry leaves its now-empty project directory behind, and
 * treating that empty shell as "leftover" would keep the entry alive forever —
 * a restorable-looking row containing nothing.
 *
 * @param entryDir - the trash entry directory.
 * @returns session directories and cache files still inside.
 */
function countLeftovers(entryDir) {
  let sessions = 0
  const sessionsDir = join(entryDir, 'sessions')
  if (existsSync(sessionsDir)) {
    for (const project of readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!project.isDirectory()) continue
      for (const session of readdirSync(join(sessionsDir, project.name), { withFileTypes: true })) {
        if (session.isDirectory()) sessions += 1
      }
    }
  }
  let cache = 0
  const cacheDir = join(entryDir, 'projcache')
  if (existsSync(cacheDir)) {
    for (const entry of readdirSync(cacheDir, { withFileTypes: true })) if (entry.isFile()) cache += 1
  }
  return { sessions, cache }
}

/**
 * Restore one trash entry back into the session store.
 *
 * A destination that already exists is never overwritten: a session id can
 * legitimately be recreated after quarantine (a resumed fork, a new session
 * reusing an id), and clobbering it would destroy the newer log to resurrect
 * the older one. Those sessions are skipped and reported so the user can decide.
 *
 * @param home - resolved DSH home.
 * @param entryId - the entry directory name.
 * @returns counts and the per-session skips.
 */
export function restoreEntry(home, entryId) {
  const entryDir = join(trashRoot(home), entryId)
  if (!existsSync(entryDir)) return { restored: 0, skipped: [], errors: [`no such trash entry: ${entryId}`] }
  const manifest = readManifest(entryDir)
  const records = Array.isArray(manifest?.sessions) ? manifest.sessions : []
  const skipped = []
  const errors = []
  let restored = 0

  for (const record of records) {
    const source = join(entryDir, 'sessions', record.projectKey ?? '_unknown', record.id)
    const projectKey = record.projectKey ?? '_unknown'
    if (!existsSync(source)) {
      errors.push(`${record.id}: quarantined log is missing`)
      continue
    }
    const destination = join(home, 'sessions', projectKey, record.id)
    if (existsSync(destination)) {
      // Do not touch the newer log; leave the quarantined copy in place too.
      skipped.push({ id: record.id, reason: 'a session with this id already exists in the store' })
      continue
    }
    try {
      mkdirSync(join(home, 'sessions', projectKey), { recursive: true })
      moveAcross(source, destination)
      if (record.cacheMoved === true) {
        const cacheSource = join(entryDir, 'projcache', `${record.id}.json`)
        if (existsSync(cacheSource)) {
          const cacheDestination = join(home, 'storages', 'session_projcache', 'sessions', `${record.id}.json`)
          mkdirSync(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
          if (!existsSync(cacheDestination)) moveAcross(cacheSource, cacheDestination)
        }
      }
      restored += 1
    } catch (error) {
      errors.push(`${record.id}: ${error.message}`)
    }
  }

  // Drop the entry only when nothing of it is left behind.
  const leftover = countLeftovers(entryDir)
  if (leftover.sessions === 0 && leftover.cache === 0) rmSync(entryDir, { recursive: true, force: true })

  return { restored, skipped, errors, entryRemoved: leftover.sessions === 0 && leftover.cache === 0 }
}

/**
 * Permanently remove trash entries.
 *
 * This is the only place in the plugin that destroys session bytes, and it is
 * reachable only through an explicit confirmation that names the entry count
 * and size.
 *
 * @param home - resolved DSH home.
 * @param entryIds - entries to remove; `[]` means every entry.
 * @returns what was removed.
 */
export function emptyTrash(home, entryIds) {
  const all = listTrash(home)
  const targets = entryIds.length === 0 ? all.entries.map((e) => e.id) : entryIds
  const removed = []
  const errors = []
  for (const id of targets) {
    const dir = join(trashRoot(home), id)
    if (!existsSync(dir)) {
      errors.push(`no such trash entry: ${id}`)
      continue
    }
    const bytes = all.entries.find((e) => e.id === id)?.bytes ?? 0
    try {
      rmSync(dir, { recursive: true, force: true })
      removed.push({ id, bytes })
    } catch (error) {
      errors.push(`${id}: ${error.message}`)
    }
  }
  return { removed, bytes: removed.reduce((sum, r) => sum + r.bytes, 0), errors }
}
