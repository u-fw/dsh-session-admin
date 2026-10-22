/**
 * The write side: one command at a time, each reporting what it actually did.
 *
 * Three properties this module exists to guarantee:
 *
 * 1. **Nothing irreversible happens in one step.** Removing a session moves it
 *    into the quarantine (see `trash.js`); only emptying the trash destroys
 *    session bytes, and the attachment collector is the single other
 *    destructive path.
 * 2. **Every path is re-verified at the moment of use.** A plan computed from an
 *    earlier scan is not a promise, so containment under the store root and the
 *    shape of an object name are checked again immediately before each removal.
 * 3. **Partial success is a result, not an exception.** A batch that moved four
 *    sessions and failed on a fifth reports both, because the alternative is a
 *    UI that cannot tell the user what state they are in.
 *
 * @module dsh-session-admin/actions
 */

import { rmSync, statSync } from 'node:fs'
import { sep } from 'node:path'

import { gather, readCachedTitles } from './gather.js'
import { resolveHome } from './scan.js'
import { buildState } from './state.js'
import { emptyTrash, quarantine, restoreEntry } from './trash.js'

/** Every command the panel may send. */
export const COMMANDS = ['archive', 'unarchive', 'pin', 'unpin', 'trash', 'restore', 'emptyTrash', 'attachmentScan', 'attachmentGc']

const KNOWN = new Set(COMMANDS)

/** Commands that need the attachment reference sweep, which reads every log. */
const DEEP_COMMANDS = new Set(['attachmentScan', 'attachmentGc'])

/** Read a non-empty string array argument. */
function idList(command, key) {
  const ids = command[key]
  if (!Array.isArray(ids) || ids.length === 0) throw new Error(`${key} must be a non-empty array`)
  for (const id of ids) if (typeof id !== 'string' || id === '') throw new Error(`${key} must contain non-empty strings`)
  return ids
}

/**
 * Index the corpus by parent so a subtree can be expanded.
 *
 * @param sessions - audit session rows carrying `parentSession`.
 * @returns parent id to child id list.
 */
export function childIndex(sessions) {
  const index = new Map()
  for (const session of sessions) {
    if (session.parentSession === undefined || session.parentSession === null) continue
    if (!index.has(session.parentSession)) index.set(session.parentSession, [])
    index.get(session.parentSession).push(session.id)
  }
  return index
}

/**
 * Every descendant of one session, breadth-first with a cycle guard.
 *
 * @param index - the child index from `childIndex`.
 * @param rootId - the subtree root, not included in the result.
 * @returns descendant ids.
 */
export function descendantIds(index, rootId) {
  const seen = new Set()
  const queue = [...(index.get(rootId) ?? [])]
  while (queue.length > 0) {
    const id = queue.shift()
    if (seen.has(id)) continue
    seen.add(id)
    queue.push(...(index.get(id) ?? []))
  }
  return [...seen]
}

/**
 * Delete the attachment objects an audit marked as unreferenced.
 *
 * Shared by the tool and the panel so the containment check exists once. The
 * plan came from an earlier scan, so every candidate is re-validated here:
 * without the prefix check a stale path would delete outside the store, and
 * `rmSync(force)` would happily do it.
 *
 * @param audit - an audit produced with `deep: true`.
 * @returns counts of what was removed, and what was refused.
 */
export function collectAttachmentObjects(audit) {
  const storeRoot = audit.attachments.root
  const prefix = storeRoot.endsWith(sep) ? storeRoot : storeRoot + sep
  let deletedObjects = 0
  let deletedBytes = 0
  const errors = []

  for (const candidatePath of audit.attachments.candidatePaths ?? []) {
    if (!candidatePath.startsWith(prefix)) {
      errors.push(`refused (outside the attachment store): ${candidatePath}`)
      continue
    }
    let bytes = 0
    try {
      bytes = statSync(candidatePath).size
    } catch {
      // Already gone: neither an error nor a deletion.
      continue
    }
    try {
      rmSync(candidatePath, { force: true })
      deletedObjects += 1
      deletedBytes += bytes
    } catch (error) {
      errors.push(`delete failed: ${candidatePath} — ${error.message}`)
    }
  }
  return { deletedObjects, deletedBytes, errors }
}

/**
 * Change one session's archive or pin slot through the registry.
 *
 * @param registry - the `workspaceRegistry` service.
 * @param action - one of archive/unarchive/pin/unpin.
 * @param id - the session id.
 * @param stopActivity - for `archive`, stop running work instead of refusing.
 */
async function applyRegistryAction(registry, action, id, stopActivity) {
  if (action === 'archive') return registry.archiveSession(id, { stopActivity: stopActivity === true })
  if (action === 'unarchive') return registry.unarchiveSession(id)
  if (action === 'pin') return registry.pinSession(id)
  return registry.unpinSession(id)
}

const REGISTRY_VERB = { archive: '归档', unarchive: '取消归档', pin: '置顶', unpin: '取消置顶' }

/**
 * Execute one panel command.
 *
 * @param ctx - plugin context; the session services are probed, not required.
 * @param command - the parsed JSON body from the panel.
 * @param options - `home` override.
 * @returns `{ ok, action, changed, skipped, errors, message, state? }`, where
 *   `state` is present only when the command already gathered the corpus at the
 *   depth the panel needs — reusing it avoids a second full reference sweep.
 */
export async function executeCommand(ctx, command, options = {}) {
  const action = command?.action
  if (typeof action !== 'string' || !KNOWN.has(action)) {
    throw new Error(`unknown action ${JSON.stringify(action)}; expected one of ${COMMANDS.join(', ')}`)
  }

  const home = resolveHome(options.home)
  if (home === undefined) throw new Error('找不到 DSH home，无法执行写操作。')

  const skipped = []
  const errors = []
  let changed = 0
  let message = ''
  let state

  const finish = () => ({ ok: errors.length === 0, action, changed, skipped, errors, message, state })

  /** Gather at the requested depth and build the state the panel will render. */
  const withState = async (deep) => {
    const gathered = await gather(ctx, { home, deep, graceMinutes: command.graceMinutes ?? 60, olderThanDays: command.olderThanDays })
    state = buildState(gathered, { titles: readCachedTitles(gathered.services.sessionProjectionCache, (gathered.records ?? []).map((r) => r.header)) })
    return gathered
  }

  if (action in REGISTRY_VERB) {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined) throw new Error('workspaceRegistry 服务不可用：无法改动归档/置顶集合。')
    for (const id of idList(command, 'sessionIds')) {
      try {
        await applyRegistryAction(registry, action, id, command.stopActivity)
        changed += 1
      } catch (error) {
        // A live session rejects `archive` without `stopActivity`; that reason is
        // the whole point of reporting it per session instead of failing the batch.
        skipped.push({ id, reason: error?.message ?? String(error) })
      }
    }
    message = `${changed} 个会话已${REGISTRY_VERB[action]}。`
    return finish()
  }

  if (action === 'trash') {
    const requested = idList(command, 'sessionIds')
    const gathered = await withState(false)
    const index = childIndex(gathered.audit.largest)
    const includeDescendants = command.includeDescendants === true

    const targets = new Set(requested)
    let cascaded = 0
    if (includeDescendants) {
      for (const id of requested) {
        for (const child of descendantIds(index, id)) {
          if (!targets.has(child)) cascaded += 1
          targets.add(child)
        }
      }
    }

    // Dropping a parent while keeping its children is allowed, but it is almost
    // never meant: the children lose the only route to them. Counted here so the
    // record of the action carries the warning, not only the dialog did.
    let stranded = 0
    if (!includeDescendants) {
      for (const id of requested) {
        for (const child of descendantIds(index, id)) if (!targets.has(child)) stranded += 1
      }
    }

    const byId = new Map(gathered.audit.largest.map((s) => [s.id, s]))
    const movable = []
    for (const id of targets) {
      const session = byId.get(id)
      if (session === undefined) {
        skipped.push({ id, reason: '不在当前语料里' })
        continue
      }
      if (session.live === true) {
        skipped.push({ id, reason: '会话正在运行（live）' })
        continue
      }
      if (session.hasLog !== true || typeof session.dir !== 'string') {
        skipped.push({ id, reason: '磁盘上没有可移动的日志' })
        continue
      }
      movable.push({ id, dir: session.dir, cachePath: session.cachePath, projectKey: session.projectKey, bytes: session.logBytes + session.cacheBytes })
    }

    const result = quarantine(home, movable, {})
    changed = result.moved.length
    errors.push(...result.errors)
    message = result.entryId === null
      ? '没有会话被移入回收站。'
      : `已把 ${changed} 个会话移入回收站（条目 ${result.entryId}，可还原）${cascaded > 0 ? `，其中 ${cascaded} 个是连带移入的子会话` : ''}。`
    if (stranded > 0) message += ` 注意：有 ${stranded} 个子会话的父会话已被移走，它们现在只能靠 id 找到。`

    // The corpus moved, so the state captured before the move is stale.
    await withState(false)
    return finish()
  }

  if (action === 'restore') {
    for (const entryId of idList(command, 'entryIds')) {
      const result = restoreEntry(home, entryId)
      changed += result.restored
      skipped.push(...result.skipped)
      errors.push(...result.errors)
    }
    message = `已还原 ${changed} 个会话。`
    await withState(false)
    return finish()
  }

  if (action === 'emptyTrash') {
    if (command.confirm !== true) throw new Error('emptyTrash 需要 confirm: true')
    const result = emptyTrash(home, [])
    changed = result.removed.length
    errors.push(...result.errors)
    message = `已永久删除 ${changed} 个回收站条目，释放 ${result.bytes} 字节。`
    await withState(false)
    return finish()
  }

  if (DEEP_COMMANDS.has(action)) {
    const gathered = await withState(true)
    const summary = gathered.audit.attachments
    if (action === 'attachmentScan') {
      message = summary.verified === true
        ? `引用计数完成：被引用 ${summary.kept.referenced} 个，可回收 ${summary.candidates} 个（${summary.candidateBytes} 字节）。`
        : '引用计数未完成，未产出候选清单。'
      return finish()
    }
    if (command.confirm !== true) throw new Error('attachmentGc 需要 confirm: true')
    if (summary.verified !== true) throw new Error('attachmentGc 拒绝在未验证的引用集合上回收。')
    const result = collectAttachmentObjects(gathered.audit)
    changed = result.deletedObjects
    errors.push(...result.errors)
    message = `已删除 ${result.deletedObjects} 个无引用附件对象，回收 ${result.deletedBytes} 字节。`
    await withState(true)
    return finish()
  }

  throw new Error(`unhandled action ${action}`)
}
