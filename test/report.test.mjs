/**
 * Report-rendering tests.
 *
 * The report is what a human reads before authorizing a delete, so these pin the
 * properties that make it safe to read: no section may be silently misnumbered,
 * an unreadable source may never render as a zero, and every truncated list must
 * admit that it was truncated.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { buildAudit } from '../lib/audit.js'
import { formatBytes, renderAudit } from '../lib/report.js'

const HEX = (p) => `${p}`.padEnd(64, '0')

/** Build an audit model from a tiny synthetic corpus. */
function auditFixture({ services = { sessionQuery: true, sessionPersistence: true }, objects = [], archivedIds = ['s2'], pinnedIds = [], deep = false } = {}) {
  return buildAudit({
    home: 'C:\\home',
    scan: {
      logs: {
        sessions: [
          { id: 's1', projectKey: '--a--', project: '--a--', dir: 'd', files: 1, bytes: 1000 },
          { id: 's2', projectKey: '--a--', project: '--a--', dir: 'd', files: 1, bytes: 2000 },
          { id: 's3', projectKey: '--b--', project: '--b--', dir: 'd', files: 1, bytes: 3000 },
        ],
        warnings: [],
      },
      cache: { root: 'c', entries: [{ id: 's1', path: 'c', bytes: 100 }, { id: 's2', path: 'c', bytes: 200 }] },
      workspace: {
        ok: true,
        archivedIds,
        pinnedIds,
        workspaces: [{ id: 'ws-a', title: 'a', path: 'C:\\a', sessionIds: ['s1'] }],
      },
      attachments: { root: 'C:\\attachments', objects, objectsBytes: objects.reduce((n, o) => n + o.bytes, 0), staged: [], stagedBytes: 0, layoutAnomalies: [] },
      requestImages: { root: 'r', files: 2, bytes: 512 },
      fileIndex: { ok: true, path: 'f', ids: new Set([`sha256:${HEX('bb')}`]), records: 1 },
      deep,
      referencedAttachmentIds: deep ? new Set() : undefined,
    },
    records: [
      { header: { id: 's1', cwd: 'C:\\a', createdAt: 1_700_000_000_000 }, live: true, persisted: true },
      { header: { id: 's2', cwd: 'C:\\a', createdAt: 1_700_000_100_000 }, live: false, persisted: true },
      { header: { id: 's3', cwd: 'C:\\elsewhere', createdAt: 1_700_000_200_000 }, live: false, persisted: true },
    ],
    snapshots: [],
    services,
  })
}

/** Extract the section headings actually emitted, in order. */
const headings = (text) => text.split('\n').filter((line) => /^[一二三四五六七八九十]+、/.test(line))

describe('formatBytes', () => {
  it('scales units and refuses nonsense', () => {
    assert.equal(formatBytes(512), '512 B')
    assert.equal(formatBytes(2048), '2.00 KB')
    assert.equal(formatBytes(5 * 1024 * 1024), '5.00 MB')
    assert.equal(formatBytes(-1), 'n/a')
  })
})

describe('renderAudit', () => {
  it('numbers sections contiguously whether or not optional sections appear', () => {
    const withoutPins = headings(renderAudit(auditFixture(), {}))
    const withPins = headings(renderAudit(auditFixture({ pinnedIds: ['s1'] }), {}))
    for (const list of [withoutPins, withPins]) {
      const numerals = list.map((h) => h.slice(0, h.indexOf('、')))
      assert.equal(new Set(numerals).size, numerals.length, 'no numeral may repeat')
      assert.deepEqual(numerals, ['一', '二', '三', '四', '五', '六', '七', '八', '九'].slice(0, numerals.length))
    }
    // The pinned section is the only one the two fixtures differ by, so it must
    // be exactly one extra heading — not a renumbering of everything after it.
    assert.equal(withPins.length, withoutPins.length + 1)
    assert.match(withPins.join('\n'), /已置顶会话/)
    assert.doesNotMatch(withoutPins.join('\n'), /已置顶会话/)
  })

  it('renders an unreadable column as unknown rather than zero', () => {
    const text = renderAudit(auditFixture({ services: { sessionQuery: false, sessionPersistence: false } }), {})
    assert.match(text, /live 未知（服务不可用）/)
    assert.doesNotMatch(text, /live 0/)
    assert.match(text, /有日志但不在持久化列表: 未知（sessionPersistence 不可用）/)
  })
  it('renders a real zero when a service did answer', () => {
    const audit = auditFixture()
    audit.corpus.live = 0
    assert.match(renderAudit(audit, {}), /live 0/)
  })

  it('states how many rows a capped list withheld', () => {
    const text = renderAudit(auditFixture(), { limit: 1 })
    assert.match(text, /另有 2 项未列出/)
    const full = renderAudit(auditFixture(), { full: true })
    assert.doesNotMatch(full, /项未列出/)
  })

  it('offers no attachment candidate list until the reference sweep ran', () => {
    const objects = [{ id: `sha256:${HEX('aa')}`, rel: 'aa', path: 'C:\\attachments\\aa', bytes: 4096, mtimeMs: Date.now() - 90 * 86_400_000, wellFormed: true }]
    const shallow = renderAudit(auditFixture({ objects }), {})
    assert.match(shallow, /未做引用计数扫描/)
    assert.doesNotMatch(shallow, /可回收候选/)
  })

  it('says plainly when nothing was changed', () => {
    assert.match(renderAudit(auditFixture(), {}), /只读审计。没有删除、没有归档、没有改动 workspace\.json。/)
    assert.match(renderAudit(auditFixture(), { gcApplied: true, actionSummary: '已删除 3 个。' }), /已删除 3 个。/)
  })

  it('never calls an unlisted session unreachable when it could not check reachability', () => {
    // Regression for a real misreport: without headers, a delegation child is
    // indistinguishable from a genuinely orphaned session, and 113 of 136
    // sessions in a real corpus turned out to be children. Claiming
    // "unreachable" without that check overstated the finding by an order of
    // magnitude.
    const blind = renderAudit(auditFixture({ services: { sessionQuery: false, sessionPersistence: false } }), {})
    assert.doesNotMatch(blind, /在侧边栏里到不了/)
    assert.match(blind, /没有 sessionQuery 就无法区分委派子会话与真正的孤立会话/)
    assert.match(blind, /这个数字是上限/)

    const sighted = renderAudit(auditFixture(), {})
    assert.match(sighted, /在侧边栏里到不了/)
  })

  it('does not ask for confirmation again after a confirmed run with nothing to collect', () => {
    const objects = [{ id: `sha256:${HEX('aa')}`, rel: 'aa/x', path: 'C:\\attachments\\aa\\x', bytes: 10, mtimeMs: Date.now(), wellFormed: true }]
    const text = renderAudit(auditFixture({ objects, deep: true }), {
      limit: 5,
      gcRan: true,
      gcApplied: false,
      actionSummary: '回收已获授权，但候选清单为空：没有删除任何对象。',
    })
    assert.doesNotMatch(text, /确认后需显式传/)
    assert.match(text, /已获授权的回收没有目标/)
  })
})
