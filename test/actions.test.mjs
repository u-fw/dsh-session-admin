/**
 * Write-side tests: quarantine, restore, and the guards around removal.
 *
 * These are the tests that matter most in this plugin, because everything here
 * touches files that cannot be reconstructed. They run against a synthetic DSH
 * home in a temp directory and assert both halves of each guarantee: that the
 * intended move happened, and that the unintended one did not.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { childIndex, collectAttachmentObjects, descendantIds } from '../lib/actions.js'
import { TRASH_DIRNAME, emptyTrash, listTrash, quarantine, restoreEntry, trashRoot } from '../lib/trash.js'

let home

/** Write a file, creating parent directories as needed. */
function put(relative, content) {
  const path = join(home, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

/** One session's storage coordinates, as the audit would produce them. */
function coords(id, projectKey = '--proj--') {
  return {
    id,
    projectKey,
    dir: join(home, 'sessions', projectKey, id),
    cachePath: join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`),
    bytes: 100,
  }
}

/** Recreate a session on disk together with its projection cache. */
function seed(id, projectKey = '--proj--') {
  put(`sessions/${projectKey}/${id}/session.v4.jsonl.zstd`, `log-${id}`)
  put(`storages/session_projcache/sessions/${id}.json`, `cache-${id}`)
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-session-admin-trash-'))
})

after(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('quarantine', () => {
  it('moves the log and its cache out of the store, leaving the store empty', () => {
    seed('sess-a')
    const result = quarantine(home, [coords('sess-a')], { stamp: 1000, suffix: 'aa' })
    assert.equal(result.moved.length, 1)
    assert.equal(result.errors.length, 0)
    assert.equal(result.entryId, '1000-aa')
    assert.equal(existsSync(join(home, 'sessions', '--proj--', 'sess-a')), false)
    assert.equal(existsSync(join(home, 'storages', 'session_projcache', 'sessions', 'sess-a.json')), false)
    assert.equal(readFileSync(join(trashRoot(home), '1000-aa', 'sessions', '--proj--', 'sess-a', 'session.v4.jsonl.zstd'), 'utf8'), 'log-sess-a')
    assert.equal(readFileSync(join(trashRoot(home), '1000-aa', 'projcache', 'sess-a.json'), 'utf8'), 'cache-sess-a')
  })

  it('records a manifest so the entry can be restored later', () => {
    const entry = listTrash(home).entries.find((e) => e.id === '1000-aa')
    assert.equal(entry.manifestMissing, false)
    assert.deepEqual(entry.sessionIds, ['sess-a'])
    assert.equal(entry.createdAt, 1000)
  })

  it('reports a session whose directory is already gone instead of inventing an entry', () => {
    const result = quarantine(home, [coords('sess-missing')], { stamp: 1001, suffix: 'bb' })
    assert.equal(result.entryId, null)
    assert.equal(result.moved.length, 0)
    assert.match(result.errors[0], /session directory is gone/)
    // An empty entry would be a restorable-looking thing with nothing in it.
    assert.equal(existsSync(join(trashRoot(home), '1001-bb')), false)
  })

  it('keeps a partial quarantine and reports the failure beside the success', () => {
    seed('sess-c')
    const result = quarantine(home, [coords('sess-c'), coords('sess-gone')], { stamp: 1002, suffix: 'cc' })
    assert.equal(result.moved.length, 1)
    assert.equal(result.errors.length, 1)
    assert.equal(result.entryId, '1002-cc')
    assert.equal(existsSync(join(home, 'sessions', '--proj--', 'sess-c')), false)
  })
})

describe('restoreEntry', () => {
  it('moves a quarantined session back into the store', () => {
    const result = restoreEntry(home, '1002-cc')
    assert.equal(result.restored, 1)
    assert.equal(result.entryRemoved, true)
    assert.equal(existsSync(join(home, 'sessions', '--proj--', 'sess-c')), true)
    assert.equal(readFileSync(join(home, 'sessions', '--proj--', 'sess-c', 'session.v4.jsonl.zstd'), 'utf8'), 'log-sess-c')
    assert.equal(existsSync(join(trashRoot(home), '1002-cc')), false)
  })

  it('never overwrites a live session that reused the id, and keeps the quarantined copy', () => {
    seed('sess-d')
    quarantine(home, [coords('sess-d')], { stamp: 2000, suffix: 'dd' })
    // A newer session now owns the id — exactly what a resumed fork can do.
    seed('sess-d')
    writeFileSync(join(home, 'sessions', '--proj--', 'sess-d', 'session.v4.jsonl.zstd'), 'newer log')

    const result = restoreEntry(home, '2000-dd')
    assert.equal(result.restored, 0)
    assert.equal(result.skipped.length, 1)
    assert.match(result.skipped[0].reason, /already exists/)
    // The newer log survives, and the older one is still recoverable by hand.
    assert.equal(readFileSync(join(home, 'sessions', '--proj--', 'sess-d', 'session.v4.jsonl.zstd'), 'utf8'), 'newer log')
    assert.equal(existsSync(join(trashRoot(home), '2000-dd', 'sessions', '--proj--', 'sess-d')), true)
  })

  it('reports an unknown entry rather than throwing', () => {
    const result = restoreEntry(home, 'no-such-entry')
    assert.equal(result.restored, 0)
    assert.match(result.errors[0], /no such trash entry/)
  })
})

describe('emptyTrash', () => {
  it('destroys bytes only when asked, and reports how many', () => {
    seed('sess-e')
    quarantine(home, [coords('sess-e')], { stamp: 3000, suffix: 'ee' })
    assert.equal(existsSync(join(trashRoot(home), '3000-ee')), true)

    const result = emptyTrash(home, [])
    assert.equal(result.removed.length >= 1, true)
    assert.equal(result.bytes > 0, true)
    assert.equal(existsSync(join(trashRoot(home), '3000-ee')), false)
    assert.equal(listTrash(home).entries.some((e) => e.id === '3000-ee'), false)
  })
})

describe('trash placement', () => {
  it('keeps the trash outside the sessions root so no scanner can see it', () => {
    assert.equal(trashRoot(home), join(home, TRASH_DIRNAME))
    assert.equal(trashRoot(home).startsWith(join(home, 'sessions')), false)
    assert.equal(trashRoot(home).startsWith(join(home, 'storages')), false)
  })
})

describe('lineage', () => {
  const sessions = [
    { id: 'root' },
    { id: 'child-1', parentSession: 'root' },
    { id: 'child-2', parentSession: 'root' },
    { id: 'grandchild', parentSession: 'child-1' },
    { id: 'unrelated' },
  ]

  it('expands a whole subtree, not just the direct children', () => {
    const ids = descendantIds(childIndex(sessions), 'root')
    assert.deepEqual(ids.sort(), ['child-1', 'child-2', 'grandchild'])
  })

  it('returns nothing for a leaf', () => {
    assert.deepEqual(descendantIds(childIndex(sessions), 'grandchild'), [])
  })

  it('terminates on a cyclic lineage instead of hanging', () => {
    const cyclic = [{ id: 'a', parentSession: 'b' }, { id: 'b', parentSession: 'a' }]
    assert.deepEqual(descendantIds(childIndex(cyclic), 'a').sort(), ['a', 'b'])
  })
})

describe('collectAttachmentObjects', () => {
  const objectPath = (rel) => join(home, 'attachments', 'v1', 'objects', rel)

  it('deletes an object inside the store and counts its bytes', () => {
    const rel = `aa/${'aa'.padEnd(64, '0')}`
    put(`attachments/v1/objects/${rel}`, 'x'.repeat(40))
    const result = collectAttachmentObjects({
      attachments: { root: join(home, 'attachments', 'v1', 'objects'), candidatePaths: [objectPath(rel)] },
    })
    assert.equal(result.deletedObjects, 1)
    assert.equal(result.deletedBytes, 40)
    assert.equal(existsSync(objectPath(rel)), false)
  })

  it('refuses a path outside the store even when the plan names it', () => {
    // The plan comes from an earlier scan; a stale or tampered entry must not be
    // able to aim a delete at an arbitrary file.
    const outside = join(home, 'sessions', '--proj--', 'victim', 'session.v4.jsonl.zstd')
    put('sessions/--proj--/victim/session.v4.jsonl.zstd', 'precious')
    const result = collectAttachmentObjects({
      attachments: { root: join(home, 'attachments', 'v1', 'objects'), candidatePaths: [outside] },
    })
    assert.equal(result.deletedObjects, 0)
    assert.match(result.errors[0], /outside the attachment store/)
    assert.equal(readFileSync(outside, 'utf8'), 'precious')
  })

  it('treats an already-missing object as neither an error nor a deletion', () => {
    const result = collectAttachmentObjects({
      attachments: { root: join(home, 'attachments', 'v1', 'objects'), candidatePaths: [objectPath(`bb/${'bb'.padEnd(64, '0')}`)] },
    })
    assert.equal(result.deletedObjects, 0)
    assert.deepEqual(result.errors, [])
  })
})
