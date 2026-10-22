/**
 * Argument-normalization tests.
 *
 * This plugin writes raw JSON Schema instead of DSH's compiled parameter spec,
 * so it owns its own input checks. The destructive path in particular must be
 * unreachable by an argument set that merely looks deliberate.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeArgs, runAudit } from '../lib/index.js'

describe('normalizeArgs', () => {
  it('defaults to a read-only session report', () => {
    const options = normalizeArgs(undefined)
    assert.equal(options.action, 'report')
    assert.equal(options.full, false)
    assert.equal(options.deep, false)
    assert.equal(options.gc, false)
    assert.equal(options.limit, 15)
    assert.equal(options.graceMinutes, 60)
  })

  it('rejects an unknown action instead of falling back to one', () => {
    assert.throws(() => normalizeArgs({ action: 'delete-everything' }), /unknown action/)
    assert.throws(() => normalizeArgs({ action: 'DELETE' }), /unknown action/)
  })

  it('rejects an out-of-range limit', () => {
    assert.throws(() => normalizeArgs({ limit: 0 }), /limit must be an integer/)
    assert.throws(() => normalizeArgs({ limit: 501 }), /limit must be an integer/)
    assert.throws(() => normalizeArgs({ limit: 1.5 }), /limit must be an integer/)
  })

  it('refuses gc without a verified reference sweep', () => {
    assert.throws(() => normalizeArgs({ action: 'attachments', gc: true, confirm: true }), /gc requires deep: true/)
  })

  it('refuses gc without explicit confirmation', () => {
    assert.throws(
      () => normalizeArgs({ action: 'attachments', gc: true, deep: true }),
      /gc requires confirm: true/,
    )
  })

  it('permits gc only with deep and confirm together', () => {
    const options = normalizeArgs({ action: 'attachments', gc: true, deep: true, confirm: true })
    assert.equal(options.gc, true)
    assert.equal(options.deep, true)
    assert.equal(options.confirm, true)
  })

  it('rejects nonsense windows rather than treating them as zero', () => {
    assert.throws(() => normalizeArgs({ graceMinutes: -1 }), /graceMinutes/)
    assert.throws(() => normalizeArgs({ olderThanDays: 1.5 }), /olderThanDays/)
  })
})
