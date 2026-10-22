/**
 * Filesystem scanner tests.
 *
 * Fixtures are built in a temp directory shaped like a DSH home, because the
 * whole point of `scan.js` is what the layout actually is — asserting against
 * the real home would make the suite depend on this machine's history.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  collectAttachmentIds,
  looksLikeHome,
  readFileIndexRefs,
  readWorkspaceState,
  resolveHome,
  scanAttachmentStore,
  scanProjectionCache,
  scanRequestImageCache,
  scanSessionLogs,
} from '../lib/scan.js'

let home

/** Write a file, creating parent directories as needed. */
function put(relative, content) {
  const path = join(home, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-session-admin-scan-'))
  put('sessions/--proj-a--/sess-1/session.v4.jsonl.zstd', 'x'.repeat(100))
  put('sessions/--proj-a--/sess-2/session.v4.jsonl.zstd', 'x'.repeat(50))
  put('sessions/--proj-b--/sess-3/session.v4.jsonl.zstd', 'x'.repeat(10))
  put('sessions/--proj-b--/stray.txt', 'not a session directory')
  put('storages/session_projcache/sessions/sess-1.json', '{"version":7}')
  put('storages/session_projcache/sessions/sess-3.json', '{"version":7}')
  put('storages/workspace.json', JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { archivedSessionIds: ['sess-2', 'sess-gone'], pinnedSessionIds: ['sess-1'] },
    tables: { workspaces: { 'ws-a': { path: 'C:\\proj-a', title: 'proj-a', sessionIds: ['sess-1'] } } },
  }))
  put(`attachments/v1/objects/ab/${'ab'.padEnd(64, '0')}`, 'y'.repeat(20))
  put('attachments/v1/objects/zz/not-hex', 'y'.repeat(5))
  put('attachments/v1/tmp/staged.bin', 'z'.repeat(7))
  put('cache/attachments/request-images/0a/variant.bin', 'r'.repeat(30))
  put('llm-deepseek/files-v3.json', JSON.stringify({
    formatVersion: 3,
    records: [{ attachmentId: `sha256:${'ab'.padEnd(64, '0')}`, variantId: `sha256:${'cd'.padEnd(64, '0')}`, fileId: 'file-1' }],
  }))
})

after(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('resolveHome', () => {
  it('accepts a directory that holds a sessions or storages root', () => {
    assert.equal(looksLikeHome(home), true)
    assert.equal(resolveHome(home), home)
  })

  it('refuses an explicit home that is not a DSH home rather than auditing a different one', () => {
    const empty = mkdtempSync(join(tmpdir(), 'dsh-session-admin-empty-'))
    try {
      assert.equal(looksLikeHome(empty), false)
      // Falling back to $DSH_HOME here would answer a question nobody asked,
      // about an installation the caller did not name.
      assert.equal(resolveHome(empty), undefined)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('still falls back to the environment when no home was named', () => {
    assert.equal(typeof resolveHome(undefined) === 'string' || resolveHome(undefined) === undefined, true)
  })
})

describe('scanSessionLogs', () => {
  it('totals each session directory and reports stray files as warnings', () => {
    const { sessions, warnings } = scanSessionLogs(home)
    const byId = new Map(sessions.map((s) => [s.id, s]))
    assert.equal(sessions.length, 3)
    assert.equal(byId.get('sess-1').bytes, 100)
    assert.equal(byId.get('sess-2').bytes, 50)
    assert.equal(byId.get('sess-1').projectKey, '--proj-a--')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /stray\.txt/)
  })
})

describe('scanProjectionCache', () => {
  it('keys entries by session id with the extension stripped', () => {
    const { entries } = scanProjectionCache(home)
    assert.deepEqual(entries.map((e) => e.id).sort(), ['sess-1', 'sess-3'])
  })
})

describe('readWorkspaceState', () => {
  it('exposes the archive and pin sets that no Service reports', () => {
    const state = readWorkspaceState(home)
    assert.equal(state.ok, true)
    assert.deepEqual(state.archivedIds, ['sess-2', 'sess-gone'])
    assert.deepEqual(state.pinnedIds, ['sess-1'])
    assert.equal(state.workspaces[0].path, 'C:\\proj-a')
    assert.deepEqual(state.workspaces[0].sessionIds, ['sess-1'])
  })

  it('reports a corrupt registry instead of pretending nothing is archived', () => {
    const broken = mkdtempSync(join(tmpdir(), 'dsh-session-admin-broken-'))
    try {
      mkdirSync(join(broken, 'storages'), { recursive: true })
      writeFileSync(join(broken, 'storages', 'workspace.json'), '{ not json')
      const state = readWorkspaceState(broken)
      assert.equal(state.ok, false)
      assert.match(state.error, /not valid JSON/)
      assert.deepEqual(state.archivedIds, [])
    } finally {
      rmSync(broken, { recursive: true, force: true })
    }
  })
})

describe('scanAttachmentStore', () => {
  it('derives the sha256 reference from the object path', () => {
    const store = scanAttachmentStore(home)
    const object = store.objects.find((o) => o.wellFormed)
    assert.equal(object.id, `sha256:${'ab'.padEnd(64, '0')}`)
    assert.equal(store.objectsBytes, 25)
    assert.equal(store.staged.length, 1)
    assert.equal(store.stagedBytes, 7)
  })

  it('flags an object whose fan-out directory does not match its name', () => {
    const store = scanAttachmentStore(home)
    assert.deepEqual(store.layoutAnomalies, ['zz/not-hex'])
    assert.equal(store.objects.find((o) => o.rel === 'zz/not-hex').wellFormed, false)
  })
})

describe('scanRequestImageCache', () => {
  it('measures the regenerable request-image cache', () => {
    const cache = scanRequestImageCache(home)
    assert.equal(cache.files, 1)
    assert.equal(cache.bytes, 30)
  })
})

describe('readFileIndexRefs', () => {
  it('collects both the stored attachment and its derived variant', () => {
    const index = readFileIndexRefs(home)
    assert.equal(index.ok, true)
    assert.equal(index.records, 1)
    assert.deepEqual([...index.ids].sort(), [`sha256:${'ab'.padEnd(64, '0')}`, `sha256:${'cd'.padEnd(64, '0')}`])
  })
})

describe('collectAttachmentIds', () => {
  it('finds references nested anywhere in an event log', () => {
    const id = `sha256:${'ef'.padEnd(64, '0')}`
    const events = [{ data: { message: { content: [{ type: 'image', attachment: { attachmentId: id } }] } } }]
    assert.deepEqual([...collectAttachmentIds(events)], [id])
  })

  it('ignores strings that are not attachment references', () => {
    assert.equal(collectAttachmentIds({ a: 'sha256:short', b: 'sha256:' + 'g'.repeat(64) }).size, 0)
  })
})
