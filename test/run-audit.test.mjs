/**
 * Whole-path tests over a synthetic DSH home.
 *
 * These exist because of a real failure: the tool rendered a perfect report on
 * the CLI and returned nothing at all through the Host, which rejects a result
 * that cannot round-trip through JSON. `divergences.workspaceRegistryError` is
 * `undefined` exactly when the registry is healthy, so the *working* case was
 * the broken one, and only calling the tool through the Host could reveal it.
 * The first test here is that assertion, kept permanently.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeArgs, runAudit } from '../lib/index.js'
import { losslessJson } from '../lib/report.js'

let home

/** Write a file, creating parent directories as needed. */
function put(relative, content) {
  const path = join(home, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-session-admin-run-'))
  put('sessions/--proj-a--/sess-1/session.v4.jsonl.zstd', 'x'.repeat(120))
  put('sessions/--proj-a--/sess-2/session.v4.jsonl.zstd', 'x'.repeat(80))
  put('storages/session_projcache/sessions/sess-1.json', '{}')
  put('storages/workspace.json', JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { archivedSessionIds: ['sess-2'], pinnedSessionIds: [] },
    tables: { workspaces: { 'ws-a': { path: 'C:\\proj-a', title: 'proj-a', sessionIds: ['sess-1'] } } },
  }))
})

after(() => {
  rmSync(home, { recursive: true, force: true })
})

/** A ctx whose optional services are all absent. */
const bareCtx = { get: () => undefined }

/** A ctx that answers every service, with a healthy registry (the failure case). */
const fullCtx = {
  get: (name) => {
    if (name === 'sessionQuery') {
      return {
        listSessions: async () => [
          { header: { id: 'sess-1', cwd: 'C:\\proj-a', createdAt: 1 }, live: true, persisted: true },
          { header: { id: 'sess-2', cwd: 'C:\\proj-a', createdAt: 2 }, live: false, persisted: true },
        ],
      }
    }
    if (name === 'sessionPersistence') return { list: async () => [{ header: { id: 'sess-1' }, eventCount: 3, sizeBytes: 120 }] }
    if (name === 'workspaceRegistry') {
      return { list: () => [{ id: 'ws-a', title: 'proj-a', path: 'C:\\proj-a', sessionIds: ['sess-1'] }] }
    }
    return undefined
  },
}

describe('runAudit value', () => {
  it('round-trips through JSON with every service absent', async () => {
    const value = await runAudit(bareCtx, normalizeArgs({ home, limit: 5 }), undefined)
    assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
    assert.equal(value.action, 'report')
    assert.match(value.text, /只读审计/)
  })

  it('round-trips through JSON when every service answers and the registry is healthy', async () => {
    // The regression: a healthy registry leaves `workspaceRegistryError`
    // undefined, and an undefined property is dropped by JSON.stringify — which
    // the Host reports as "value is not lossless JSON".
    const value = await runAudit(fullCtx, normalizeArgs({ home, limit: 5 }), undefined)
    assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
    assert.equal('workspaceRegistryError' in value.divergences, false)
    assert.equal(value.divergences.workspaceRegistryOk, true)
    // A field that is unknowable keeps an explicit null so a consumer can tell
    // it apart from an empty list.
    assert.equal(Array.isArray(value.divergences.logWithoutPersistence), true)
  })

  it('surfaces the live flag and the cwd label once the query service answers', async () => {
    const value = await runAudit(fullCtx, normalizeArgs({ home, limit: 5 }), undefined)
    assert.equal(value.divergences.persistenceWithoutLog.length, 0)
    assert.match(value.text, /LIVE/)
    assert.match(value.text, /C:\\proj-a/)
  })

  it('reports live as unknown, never as zero, without the query service', async () => {
    const value = await runAudit(bareCtx, normalizeArgs({ home, limit: 5 }), undefined)
    assert.equal(value.text.includes('live 0'), false)
    assert.match(value.text, /live 未知/)
  })

  it('refuses a deep attachment sweep without the service that can decode logs', async () => {
    await assert.rejects(
      runAudit(bareCtx, normalizeArgs({ action: 'attachments', deep: true, home }), undefined),
      /sessionQuery 服务/,
    )
  })

  it('lists attachment candidates only after the sweep, and never plans deletion for them', async () => {
    const released = []
    const sweepCtx = {
      get: (name) => {
        const service = fullCtx.get(name)
        if (name !== 'sessionQuery') return service
        return {
          ...service,
          observeSession: async (id) => ({
            events: [],
            // The lease disposer is the well-known symbol, NOT `.dispose()`.
            // A fake that only implements `.dispose()` would let a real leak
            // pass, so this fake implements only the symbol.
            [Symbol.dispose]() {
              released.push(id)
            },
          }),
        }
      },
    }
    const value = await runAudit(sweepCtx, normalizeArgs({ action: 'attachments', deep: true, home, graceMinutes: 0 }), undefined)
    assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
    assert.match(value.text, /未做引用计数扫描|可回收候选/)
    assert.equal(value.deletedObjects, 0)
    // Every observation must be released: the query cache is small and a pinned
    // entry is never evicted, so a leak would hold the whole corpus in memory.
    assert.deepEqual(released.sort(), ['sess-1', 'sess-2'])
  })

  it('releases the lease even when reading a session fails', async () => {
    const released = []
    const failingCtx = {
      get: (name) => {
        if (name === 'sessionPersistence') return undefined
        const service = fullCtx.get(name)
        if (name !== 'sessionQuery') return service
        return {
          ...service,
          observeSession: async (id) => {
            if (id === 'sess-2') throw new Error('boom')
            return { events: [], [Symbol.dispose]: () => released.push(id) }
          },
        }
      },
    }
    const value = await runAudit(failingCtx, normalizeArgs({ action: 'attachments', deep: true, home }), undefined)
    assert.deepEqual(released, ['sess-1'])
    assert.match(value.text, /读取失败/)
  })

  it('rejects an unknown home instead of reporting an empty installation', async () => {
    await assert.rejects(runAudit(bareCtx, normalizeArgs({ home: join(home, 'nope') }), undefined), /no DSH home found/)
  })
})

describe('losslessJson', () => {
  it('drops undefined properties and non-finite numbers rather than failing later', () => {
    const cleaned = losslessJson({ a: 1, b: undefined, c: Number.POSITIVE_INFINITY, d: [1, undefined, Number.NaN], e: { f: undefined } })
    assert.deepEqual(cleaned, { a: 1, c: null, d: [1, null], e: {} })
    assert.deepEqual(JSON.parse(JSON.stringify(cleaned)), cleaned)
  })

  it('keeps null and false, which are real values', () => {
    assert.deepEqual(losslessJson({ a: null, b: false, c: 0, d: '' }), { a: null, b: false, c: 0, d: '' })
  })
})
