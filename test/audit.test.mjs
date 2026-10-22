/**
 * Audit-model tests.
 *
 * These pin the distinctions the report depends on: a column that could not be
 * read must stay `undefined` rather than becoming `0`, "unaccounted" must not
 * swallow delegation children, and attachment retention must be attributable to
 * the rule that kept each object.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { analyzeAttachments, buildAudit } from '../lib/audit.js'

const HEX = (prefix) => `${prefix}`.padEnd(64, '0')

/** A minimal scan fixture: two projects, three sessions, one archived. */
function fixture(overrides = {}) {
  return {
    logs: {
      sessions: [
        { id: 's1', projectKey: '--a--', project: '--a--', dir: 'x', files: 1, bytes: 100 },
        { id: 's2', projectKey: '--a--', project: '--a--', dir: 'x', files: 1, bytes: 200 },
        { id: 's3', projectKey: '--b--', project: '--b--', dir: 'x', files: 1, bytes: 300 },
      ],
      warnings: [],
    },
    cache: {
      root: 'x',
      entries: [
        { id: 's1', path: 'x', bytes: 10 },
        { id: 's3', path: 'x', bytes: 30 },
        { id: 'ghost', path: 'x', bytes: 5 },
      ],
    },
    workspace: {
      ok: true,
      archivedIds: ['s2'],
      pinnedIds: [],
      workspaces: [{ id: 'ws-a', title: 'a', path: 'C:\\a', sessionIds: ['s1'] }],
    },
    attachments: { root: 'C:\\attachments', objects: [], objectsBytes: 0, staged: [], stagedBytes: 0, layoutAnomalies: [] },
    requestImages: { root: 'x', files: 0, bytes: 0 },
    fileIndex: { ok: true, path: 'x', ids: new Set(), records: 0 },
    ...overrides,
  }
}

describe('buildAudit', () => {
  it('separates a session no workspace accounts for from one that is merely unlisted', () => {
    const audit = buildAudit({
      home: 'h',
      scan: fixture(),
      records: [
        { header: { id: 's1', cwd: 'C:\\a', createdAt: 1 }, live: false, persisted: true },
        { header: { id: 's2', cwd: 'C:\\a', createdAt: 2 }, live: false, persisted: true },
        { header: { id: 's3', cwd: 'C:\\nowhere', createdAt: 3 }, live: false, persisted: true },
      ],
      snapshots: [],
      services: { sessionQuery: true, sessionPersistence: true },
    })
    // s2 is unlisted but its cwd belongs to a registered workspace, so it is
    // reachable and must not be counted as unaccounted.
    assert.deepEqual(audit.divergences.unaccounted, ['s3'])
    assert.equal(audit.corpus.unaccounted.count, 1)
    assert.equal(audit.corpus.unaccounted.bytes, 330)
  })

  it('excludes delegation children from the unaccounted count', () => {
    const audit = buildAudit({
      home: 'h',
      scan: fixture(),
      records: [
        { header: { id: 's1', cwd: 'C:\\a', createdAt: 1 }, live: false, persisted: true },
        { header: { id: 's2', origin: 'subagent', cwd: 'C:\\a', createdAt: 2 }, live: false, persisted: true },
        { header: { id: 's3', cwd: 'C:\\b', createdAt: 3 }, live: false, persisted: true },
      ],
      snapshots: [],
      services: { sessionQuery: true, sessionPersistence: true },
    })
    // s2 is a delegation child: unlisted, but reachable through its parent.
    assert.deepEqual(audit.divergences.unaccounted, ['s3'])
    assert.equal(audit.corpus.subagent, 1)
  })

  it('treats a projection-cache file with no session behind it as a cache orphan, not a session', () => {
    const audit = buildAudit({
      home: 'h',
      scan: fixture(),
      records: [{ header: { id: 's1', cwd: 'C:\\a', createdAt: 1 }, live: false, persisted: true }],
      snapshots: [],
      services: { sessionQuery: true, sessionPersistence: true },
    })
    assert.deepEqual(audit.divergences.cacheWithoutLog, ['ghost'])
    assert.equal(audit.largest.some((s) => s.id === 'ghost'), false)
    assert.equal(audit.corpus.unaccounted.count, 2)
  })

  it('uses the recorded cwd as the project label and falls back to the storage key', () => {
    const audit = buildAudit({
      home: 'h',
      scan: fixture(),
      records: [{ header: { id: 's1', cwd: 'C:\\real\\path', createdAt: 1 }, live: false, persisted: true }],
      snapshots: [],
      services: { sessionQuery: true, sessionPersistence: true },
    })
    const s1 = audit.largest.find((s) => s.id === 's1')
    assert.equal(s1.project, 'C:\\real\\path')
    const s2 = audit.largest.find((s) => s.id === 's2')
    assert.equal(s2.project, '--a--')
  })

  it('reports persistence divergences as unknown when the service is absent', () => {
    const audit = buildAudit({
      home: 'h',
      scan: fixture(),
      records: [],
      snapshots: [],
      services: { sessionQuery: false, sessionPersistence: false },
    })
    // `null`, not `undefined`: the value crosses a JSON boundary that drops
    // undefined, which would make "could not read" indistinguishable from
    // "read, found nothing".
    assert.equal(audit.divergences.logWithoutPersistence, null)
    assert.equal(audit.divergences.persistenceWithoutLog, null)
    assert.equal(audit.corpus.live, undefined)
    // Filesystem-only comparisons stay meaningful without any Service.
    assert.deepEqual(audit.divergences.cacheWithoutLog, ['ghost'])
  })

  it('computes persistence divergences when the service answers', () => {
    const audit = buildAudit({
      home: 'h',
      scan: fixture(),
      records: [],
      snapshots: [{ header: { id: 's1' } }, { header: { id: 's9' } }],
      services: { sessionQuery: false, sessionPersistence: true },
    })
    assert.deepEqual(audit.divergences.logWithoutPersistence, ['s2', 's3'])
    assert.deepEqual(audit.divergences.persistenceWithoutLog, ['s9'])
  })

  it('totals archived bytes across logs and caches', () => {
    const audit = buildAudit({ home: 'h', scan: fixture(), records: [], snapshots: [], services: {} })
    assert.equal(audit.corpus.archived.count, 1)
    assert.equal(audit.corpus.archived.bytes, 200)
  })

  it('measures how much of the corpus is delegation children', () => {
    const audit = buildAudit({
      home: 'h',
      scan: fixture(),
      records: [
        { header: { id: 's1', cwd: 'C:\\a', createdAt: 1 }, live: false, persisted: true },
        { header: { id: 's2', origin: 'subagent', parentSession: 's1', delegationDepth: 1, cwd: 'C:\\a', createdAt: 2 }, live: false, persisted: true },
        { header: { id: 's3', cwd: 'C:\\b', createdAt: 3 }, live: false, persisted: true },
      ],
      snapshots: [],
      services: { sessionQuery: true, sessionPersistence: true },
    })
    assert.equal(audit.corpus.subagent, 1)
    // s2 alone: 200 log bytes, and this fixture holds no projection cache for it.
    assert.equal(audit.corpus.subagentBytes, 200)
  })

  it('leaves the subagent footprint unknown without the query service', () => {
    const audit = buildAudit({ home: 'h', scan: fixture(), records: [], snapshots: [], services: { sessionQuery: false } })
    assert.equal(audit.corpus.subagent, undefined)
    assert.equal(audit.corpus.subagentBytes, undefined)
  })

  it('counts the descendants of an archived session, which archiving did not touch', () => {
    // s2 is archived; s1 is its child, and s3 is a grandchild. Only the subtree
    // matters: deleting s2 alone would strand both.
    const audit = buildAudit({
      home: 'h',
      scan: fixture(),
      records: [
        { header: { id: 's1', origin: 'subagent', parentSession: 's2', cwd: 'C:\\a', createdAt: 1 }, live: false, persisted: true },
        { header: { id: 's2', cwd: 'C:\\a', createdAt: 2 }, live: false, persisted: true },
        { header: { id: 's3', origin: 'subagent', parentSession: 's1', cwd: 'C:\\a', createdAt: 3 }, live: false, persisted: true },
      ],
      snapshots: [],
      services: { sessionQuery: true, sessionPersistence: true },
    })
    const [row] = audit.archivedCascades
    assert.equal(row.id, 's2')
    assert.equal(row.descendants, 2)
    // s1: 100 log + 10 cache; s3: 300 log + 30 cache.
    assert.equal(row.descendantBytes, 440)
    // s2 holds 200 log bytes and no projection cache in this fixture.
    assert.equal(row.ownBytes, 200)
    assert.equal(row.totalBytes, 640)
  })

  it('reports no cascade for an archived session whose subtree is empty', () => {
    const audit = buildAudit({
      home: 'h',
      scan: fixture(),
      records: [
        { header: { id: 's1', cwd: 'C:\\a', createdAt: 1 }, live: false, persisted: true },
        { header: { id: 's2', cwd: 'C:\\a', createdAt: 2 }, live: false, persisted: true },
      ],
      snapshots: [],
      services: { sessionQuery: true, sessionPersistence: true },
    })
    assert.deepEqual(audit.archivedCascades, [])
  })
})

describe('analyzeAttachments', () => {
  const now = 1_000_000_000
  const day = 86_400_000
  const object = (hex, bytes, ageDays) => ({
    id: `sha256:${HEX(hex)}`,
    rel: 'x',
    path: `C:\\attachments\\${hex}`,
    bytes,
    mtimeMs: now - ageDays * day,
    wellFormed: true,
  })

  it('keeps an object for each independent reason and reports them separately', () => {
    const result = analyzeAttachments({
      attachments: {
        root: 'C:\\attachments',
        objects: [object('aa', 10, 30), object('bb', 20, 30), object('cc', 40, 30), object('dd', 80, 0)],
        objectsBytes: 150,
      },
      referenced: new Set([`sha256:${HEX('aa')}`]),
      indexRefs: new Set([`sha256:${HEX('bb')}`]),
      deep: true,
      now,
      graceMs: day,
    })
    assert.deepEqual(result.kept, { referenced: 1, indexed: 1, youngerThanGrace: 1 })
    assert.equal(result.candidates, 1)
    assert.equal(result.candidateBytes, 40)
    assert.match(result.candidatePaths[0], /cc$/)
  })

  it('honours olderThanMs as an extra floor', () => {
    const result = analyzeAttachments({
      attachments: { root: 'r', objects: [object('aa', 10, 3), object('bb', 20, 30)], objectsBytes: 30 },
      referenced: new Set(),
      indexRefs: new Set(),
      deep: true,
      now,
      graceMs: day,
      olderThanMs: 7 * day,
    })
    assert.equal(result.candidates, 1)
    assert.match(result.candidatePaths[0], /bb$/)
  })

  it('produces no candidate list at all when the reference set was never verified', () => {
    const result = analyzeAttachments({
      attachments: { root: 'r', objects: [object('aa', 10, 30)], objectsBytes: 10 },
      referenced: new Set(),
      indexRefs: new Set(),
      deep: false,
      now,
      graceMs: day,
    })
    // An unread reference set must not be representable as "nothing references
    // it": without the scan there is no plan, not an empty one.
    assert.equal(result.verified, false)
    assert.equal(result.candidates, 0)
    assert.deepEqual(result.candidatePaths, [])
  })
})
