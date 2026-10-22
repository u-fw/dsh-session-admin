/**
 * Render an audit model as the text a caller reads.
 *
 * The report is the deliverable: this plugin's first version reports and changes
 * nothing, so the wording has to make "this is what exists" and "this is what
 * would be removed" impossible to misread. Three rules follow from that:
 *
 * - a column whose source service was unavailable prints as `未知`, never as `0`;
 * - section numbers are generated, so no combination of skipped sections can
 *   produce a gap or a repeat;
 * - every list is explicitly capped and says so.
 *
 * Reloading note: under a profile with `hmr.config.root: []` (the stock default)
 * Node caches this module by URL and no edit here takes effect without a
 * restart. See README.zh.md, "开发与重载".
 *
 * @module dsh-session-admin/report
 */

/** Format a byte count for a human reader. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'n/a'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[unit]}`
}

/** Format an epoch-millisecond stamp as an ISO minute, or a dash. */
export function formatTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '-'
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
}

/** Render a possibly-unknown count. */
const count = (value, suffix = '') => (value === undefined ? '未知（服务不可用）' : `${value}${suffix}`)

/** A short display id: session ids are long enough that the tail is the discriminator. */
export const shortId = (id) => (typeof id === 'string' && id.length > 20 ? `${id.slice(0, 14)}…${id.slice(-6)}` : String(id))

/**
 * Reduce a value to what JSON can carry losslessly.
 *
 * The Host rejects a tool result that cannot round-trip through JSON, so
 * `undefined` — which `JSON.stringify` silently drops — is a hard failure, not a
 * cosmetic one. That makes an optional field dangerous: `workspaceRegistryError`
 * is absent exactly when the registry is healthy, which is the common case, and
 * a report that renders perfectly on the CLI never reaches the model at all.
 *
 * Non-finite numbers become `null` for the same reason: `Infinity` also fails to
 * round-trip. Everything else unsupported (functions, symbols, bigint) is
 * dropped, which the rendered text already accounts for.
 *
 * @param value - any value reachable from the tool result.
 * @returns a structurally identical value containing only lossless JSON.
 */
export function losslessJson(value) {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) {
    const out = []
    for (const item of value) {
      const converted = losslessJson(item)
      if (converted !== undefined) out.push(converted)
    }
    return out
  }
  if (type === 'object') {
    const out = {}
    for (const [key, nested] of Object.entries(value)) {
      const converted = losslessJson(nested)
      if (converted !== undefined) out[key] = converted
    }
    return out
  }
  return undefined
}

/** Render `label: value` lines as a flat list of strings. */
const lines = (pairs) => pairs.map(([label, value]) => `  ${label}: ${value}`)

/** Render a capped list, noting how many entries were withheld. */
function capped(items, limit, render, note = (n) => `  … 另有 ${n} 项未列出（用 full: true 展开）`) {
  const shown = items.slice(0, limit).map(render)
  if (items.length > limit) shown.push(note(items.length - limit))
  return shown
}

/** Chinese section numerals, in order; enough for the sections this report has. */
const NUMERALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二']

/** Collects sections and numbers them as they are actually emitted. */
function createLayout() {
  const out = []
  return {
    push: (...chunks) => out.push(...chunks),
    /** Start a section; returns the heading lines to push. */
    section(title) {
      return ['', `${NUMERALS[out.filter((l) => /^[一二三四五六七八九十]+、/.test(l)).length] ?? '?'}、${title}`, '-'.repeat(72)]
    },
    text: () => out.join('\n'),
  }
}

/**
 * Render the whole audit.
 *
 * @param audit - model from `buildAudit`.
 * @param options - display controls.
 * @param options.limit - maximum rows per list; `full` overrides it.
 * @param options.full - list every row instead of the first `limit`.
 * @param options.gcApplied - whether attachment reclamation actually ran.
 * @param options.actionSummary - what this invocation did, stated plainly.
 * @returns the report text.
 */
export function renderAudit(audit, options = {}) {
  const limit = options.full === true ? Number.POSITIVE_INFINITY : (options.limit ?? 15)
  const { corpus, divergences: d, services } = audit
  const layout = createLayout()
  const { push, section } = layout

  push('DSH 会话存储审计（只读，未删除任何文件）')
  push('='.repeat(72))
  push(...lines([
    ['DSH home', audit.home],
    ['生成时间', formatTime(audit.generatedAt)],
    ['数据来源', `sessionQuery ${services.sessionQuery ? '✓' : '✗'} · sessionPersistence ${services.sessionPersistence ? '✓' : '✗'} · workspaceRegistry ${services.workspaceRegistry ? '✓' : '✗'}`],
  ]))
  if (!services.sessionQuery) {
    push('  未接入会话服务时，本报告只反映磁盘事实：体积与文件位置准确，创建时间与 live 状态未知。')
  }

  push(...section('总量'))
  push(...lines([
    ['会话总数', `${corpus.sessions}（live ${count(corpus.live)}，子会话 ${count(corpus.subagent)}）`],
    ['子会话占用', corpus.subagentBytes === undefined ? '未知（sessionQuery 不可用）' : `${formatBytes(corpus.subagentBytes)}，占会话日志的 ${corpus.logBytes === 0 ? '0' : Math.round((corpus.subagentBytes / corpus.logBytes) * 100)}%`],
    ['会话日志', formatBytes(corpus.logBytes)],
    ['投影缓存', formatBytes(corpus.cacheBytes)],
    ['已归档', `${corpus.archived.count} 个，占 ${formatBytes(corpus.archived.bytes)}（日志 + 缓存）`],
    ['已置顶', `${corpus.pinned} 个`],
    ['未登记会话', `${corpus.unaccounted.count} 个，占 ${formatBytes(corpus.unaccounted.bytes)}`],
    ['工作区登记', `${corpus.workspaceRecords} 个`],
  ]))

  push(...section('按项目'))
  push(...capped(audit.projects, limit, (p) =>
    `  ${String(p.sessions).padStart(4)} 个 ${formatBytes(p.bytes).padStart(9)}  归档 ${String(p.archived).padStart(3)}  未登记 ${String(p.unaccounted).padStart(3)}  ${p.project}`))

  push(...section('已归档会话（归档只是标记，日志与缓存都还在）'))
  if (audit.archivedSessions.length === 0) {
    push('  （无）')
  } else {
    push(...capped(audit.archivedSessions, limit, (s) =>
      `  ${shortId(s.id)}  ${formatBytes(s.logBytes + s.cacheBytes).padStart(9)}  建立 ${formatTime(s.createdAt)}${s.live === true ? '  LIVE！' : ''}  ${s.project}`))
    push(`  合计可回收：${formatBytes(corpus.archived.bytes)}`)
  }

  const cascades = audit.archivedCascades ?? []
  if (cascades.length > 0) {
    const totalDescendants = cascades.reduce((n, row) => n + row.descendants, 0)
    const totalDescendantBytes = cascades.reduce((n, row) => n + row.descendantBytes, 0)
    push('')
    push(`  ⚠ 其中 ${cascades.length} 个归档会话带子会话，共 ${totalDescendants} 个、${formatBytes(totalDescendantBytes)}。`)
    push('    归档不会连带处理子会话，而子会话通常没有自己的工作区登记、只能通过父会话到达。')
    push('    只删父会话的日志，这些子会话就会变成谁也到不了的孤儿，却仍占满磁盘。')
    push(...capped(cascades, limit, (row) =>
      `    ${shortId(row.id)}  自身 ${formatBytes(row.ownBytes).padStart(9)}  +  ${String(row.descendants).padStart(3)} 个子会话 ${formatBytes(row.descendantBytes).padStart(9)}  =  ${formatBytes(row.totalBytes)}`))
    push(`    含子会话在内的真实清理量：${formatBytes(corpus.archived.bytes + totalDescendantBytes)}（不含附件）`)
  } else if (audit.archivedSessions.length > 0 && !services.sessionQuery) {
    // Parentage lives in session headers. Without them this check cannot run at
    // all, and silently omitting the warning would read as "no archived session
    // has children" — the opposite of what a real corpus showed (6 of 10 did).
    push('')
    push('  ⚠ 缺少 sessionQuery：无法读取会话 header，因此**没有**检查归档会话是否带子会话。')
    push('    父子关系只存在于 header 里（parentSession / origin），磁盘目录名不携带它。')
  }

  if (audit.pinnedSessions.length > 0) {
    push(...section('已置顶会话'))
    push(...capped(audit.pinnedSessions, limit, (s) =>
      `  ${shortId(s.id)}  ${formatBytes(s.logBytes + s.cacheBytes).padStart(9)}  建立 ${formatTime(s.createdAt)}  ${s.project}`))
  }

  if (d.unaccounted.length > 0) {
    const byId = new Map(audit.largest.map((s) => [s.id, s]))
    const titled = services.sessionQuery
      ? '未登记会话（不在任何工作区的 sessionIds 里，且 cwd 不对应任何已登记工作区）'
      : '不在工作区登记里的会话（缺少会话服务，无法判断可达性）'
    push(...section(titled))
    if (services.sessionQuery) {
      push('  这类会话在侧边栏里到不了，但日志仍完整占着磁盘。')
    } else {
      // Without headers this list is only "not in the accounting slots". A
      // delegation child is normally unlisted too, so presenting it as
      // unreachable would overstate the finding by an order of magnitude.
      push('  注意：没有 sessionQuery 就无法区分委派子会话与真正的孤立会话。')
      push('  子会话通常也不在工作区登记里，但可通过父会话到达——所以这个数字是上限，不是"到不了"的会话数。')
    }
    push(...capped(d.unaccounted.map((id) => byId.get(id) ?? { id, logBytes: 0, cacheBytes: 0, project: '(未知)' }), limit, (s) =>
      `  ${shortId(s.id)}  ${formatBytes(s.logBytes + s.cacheBytes).padStart(9)}  ${s.project}`))
    push(`  合计：${formatBytes(corpus.unaccounted.bytes)}`)
  }

  push(...section('最大的会话'))
  push(...capped(audit.largest, Math.min(limit, 20), (s) =>
    `  ${formatBytes(s.logBytes).padStart(9)}  ${shortId(s.id)}  ${formatTime(s.createdAt)}  ${s.archived ? '[归档]' : ''}${s.live === true ? '[LIVE]' : ''}  ${s.project}`))

  push(...section('两侧视图的分歧（这些才是有风险的清理对象）'))
  push(...lines([
    ['workspace.json 可读', d.workspaceRegistryOk ? '是' : `否 —— ${d.workspaceRegistryError}`],
    ['有缓存无日志', `${d.cacheWithoutLog.length} 个（纯垃圾，可直接删缓存）`],
    ['有日志无缓存', `${d.logWithoutCache.length} 个（下次打开会冷重放）`],
    ['有日志但不在持久化列表', d.logWithoutPersistence === null ? '未知（sessionPersistence 不可用）' : `${d.logWithoutPersistence.length} 个`],
    ['在持久化列表但无日志', d.persistenceWithoutLog === null ? '未知（sessionPersistence 不可用）' : `${d.persistenceWithoutLog.length} 个`],
    ['已归档但日志已不在', `${d.archivedWithoutLog.length} 个（归档集合里的悬挂 id）`],
    ['已置顶但日志已不在', `${d.pinnedWithoutLog.length} 个（置顶集合里的悬挂 id）`],
    ['目录结构异常', `${d.layoutWarnings.length} 条`],
  ]))
  if (d.layoutWarnings.length > 0) push(...capped(d.layoutWarnings, 5, (w) => `    ! ${w}`))

  const a = audit.attachments
  push(...section('附件仓库（内容寻址，删会话不会回收它们）'))
  push(...lines([
    ['对象数', `${a.objects}，共 ${formatBytes(a.objectsBytes)}`],
    ['暂存区', `${a.staged} 个，共 ${formatBytes(a.stagedBytes)}`],
    ['命名异常', `${a.layoutAnomalies.length} 个`],
    ['请求图片缓存', `${audit.requestImageCache.files} 个，共 ${formatBytes(audit.requestImageCache.bytes)}（可再生，可整体清空）`],
    ['provider 文件索引', audit.fileIndex.ok ? `可读，${audit.fileIndex.records} 条记录` : `不可读 —— ${audit.fileIndex.error ?? '不存在'}`],
  ]))
  if (!a.deep) {
    push('')
    push('  未做引用计数扫描，因此无法给出可回收体积。')
    push('  运行 action: "attachments", deep: true 会读取所有会话日志，得出精确的未引用对象清单。')
  } else {
    push('')
    push(...lines([
      ['扫描到的引用 id', count(a.referencedIds, ' 个')],
      ['保留：被会话引用', `${a.kept.referenced} 个`],
      ['保留：provider 索引在册', `${a.kept.indexed} 个`],
      ['保留：在宽限期内', `${a.kept.youngerThanGrace} 个`],
      ['可回收候选', `${a.candidates} 个，共 ${formatBytes(a.candidateBytes)}`],
    ]))
    if (a.candidateSample.length > 0) {
      push('  最大的候选对象：')
      push(...a.candidateSample.map((o) => `    ${formatBytes(o.bytes).padStart(9)}  闲置 ${String(o.ageDays).padStart(4)} 天  ${o.id.slice(0, 26)}…`))
    }
    if (options.gcRan === true) {
      push('')
      push(
        options.gcApplied === true
          ? '  以上候选已按 confirm 授权删除。'
          : '  已获授权的回收没有目标：候选清单为空，未删除任何对象。',
      )
    } else {
      push('')
      push('  以上为候选清单，本次未删除。确认后需显式传 gc: true, confirm: true。')
    }
  }

  push(...section('本次动作'))
  push(`  ${options.actionSummary ?? '只读审计。没有删除、没有归档、没有改动 workspace.json。'}`)

  return layout.text()
}
