/**
 * Client half of the session admin panel: storage hygiene for this DSH
 * installation's session corpus.
 *
 * One read (`GET /session-admin/state`) feeds every number on the page, and one
 * command (`POST /session-admin/action`) both mutates and returns the next
 * state, so the panel never re-fetches after a command and never invents a
 * figure of its own.
 *
 * The distinction that shapes this file: `null` means "the host could not tell
 * us" — usually because a Host service was unavailable — and that is NOT zero.
 * Those values render as `—`, and the page names the missing services instead
 * of showing a confident 0. The same rule governs the attachment GC area: an
 * unverified scan renders "not scanned", never "0 reclaimable".
 *
 * Destructive commands (trash, attachment GC, empty trash) are two-step by
 * construction: the button opens an inline confirmation that states what will
 * happen and how many bytes it frees, and only the confirmation fires the
 * command. A row or selection with descendants must pick 仅这些会话 or
 * 连同 N 个子会话 explicitly, because the host cannot guess.
 *
 * Bundle form follows every shipped client half: factory-form CJS registering
 * itself on `window.__ModuleLoader__`, requiring only the platform seed word
 * (`react`) and reaching the slot, locale and layout services through cordis.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-admin',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    /** Host half's JSON routes: one read, one command. */
    const STATE_URL = '/session-admin/state'
    const ACTION_URL = '/session-admin/action'
    /** Slot this page occupies: a Settings section, a sidebar row, a panel. */
    const SECTION = 'settings.section'
    /** Sidebar global-panel row and the centre-column slot it selects. */
    const PANELLIST = 'sidebar.panellist'
    const MAIN = 'main'
    /**
     * Shared id: the panellist entry's `id` is what the shell hands to
     * `ctx.layout.selectPanel`, and the `main` entry must carry the same value
     * as its `key` — that identity is the entire link between the two.
     */
    const PANEL_ID = 'session-admin'
    /** This plugin's locale namespace. */
    const NS = 'dsh-session-admin'
    /** Marker for "the host could not answer"; never rendered as 0. */
    const UNKNOWN = '—'

    //#region dictionaries
    const DICTIONARIES = {
      zh: {
        nav: '会话管理',
        title: '会话管理',
        intro: '会话存储的巡检面板：每个会话占用的日志与投影体积、归档与置顶状态、回收站内容，以及没有任何引用指向的附件对象。',
        homeLabel: '主目录：{path}',
        refresh: '刷新',
        busyRefresh: '读取中…',
        busy: '处理中…',
        back: '← 返回对话',
        loading: '正在读取会话状态…',
        errorFetch: '无法读取会话状态：{error}',
        errorHost: '宿主端返回了失败结果：{error}',
        unknownHostFailure: '未知宿主错误',
        retry: '重试',
        cardSessions: '会话总数',
        cardSessionsNote: '在线 {live} · 工作区记录 {records}',
        cardBytes: '占用体积',
        cardBytesNote: '日志 {log} · 投影缓存 {cache} · 未计入工作区 {unaccounted}',
        cardArchived: '已归档',
        cardSubagent: '子会话',
        cardTrash: '回收站',
        filterAll: '全部',
        filterArchived: '已归档',
        filterActive: '未归档',
        filterSubagent: '子会话',
        filterDeletable: '可删除',
        projectAll: '全部项目',
        projectTitle: '按项目筛选',
        shownCount: '显示 {shown} / {total} 个会话',
        selectedCount: '已选 {n} 项',
        selectAll: '全选当前筛选结果',
        clearSelection: '清除选择',
        archive: '归档',
        unarchive: '取消归档',
        pin: '置顶',
        unpin: '取消置顶',
        trash: '移入回收站',
        colSession: '会话',
        colProject: '项目',
        colBytes: '体积',
        colCreated: '建立时间',
        colMarks: '标记',
        colActions: '操作',
        empty: '没有符合当前筛选的会话。',
        selectRow: '选择该会话',
        bytesTitle: '日志 {log} · 投影缓存 {cache}',
        projectUnknown: '未归属项目',
        chipArchived: '归档',
        chipPinned: '置顶',
        chipLive: 'LIVE',
        chipSubagent: '子会话',
        chipUnaccounted: '未登记',
        chipBlocked: '不可删除',
        chipUnknown: '—',
        unknownMark: '未知：宿主未提供该信息，因此显示为 —，而不是 0',
        descendants: '{n} 个子会话',
        descendantsExpand: '展开子会话',
        descendantsCollapse: '收起子会话',
        descendantsSummary: '该会话下有 {n} 个子会话，合计 {bytes}。',
        descendantsTotal: '连同自身合计 {bytes}。',
        descendantsCapped: '仅列出前 {n} 个子会话。',
        descendantsMissing: '本次结果未包含这些子会话的明细，仅有上面的合计。',
        trashHint: '移入回收站（可还原）',
        attachTitle: '附件对象',
        attachObjects: '对象 {n} 个 · {bytes}',
        attachStaged: '暂存 {n} 个 · {bytes}',
        attachScan: '扫描引用',
        attachScanning: '扫描中…',
        attachCandidates: '可回收 {n} 个 · {bytes}',
        attachNotScanned: '未扫描',
        attachNotScannedNote: '引用关系尚未核对，所以这里给不出可回收数量——它不是 0。',
        attachNone: '没有可回收的对象。',
        attachGc: '回收',
        attachGcBusy: '回收中…',
        trashTitle: '回收站',
        trashSummary: '{entries} 个条目 · {sessions} 个会话 · {bytes}',
        trashEmpty: '回收站是空的。',
        trashCreated: '创建于 {time}',
        trashEntrySessions: '{n} 个会话',
        restore: '还原',
        emptyTrash: '清空回收站',
        confirmTrashTitle: '确认移入回收站',
        confirmTrashBody: '将把 {n} 个会话（{bytes}）移入回收站；回收站中的会话可以还原。',
        confirmOnlyThese: '仅这些会话',
        confirmWithDescendants: '连同 {n} 个子会话',
        confirmDescendantsNote: '所选会话名下共有 {n} 个子会话（{bytes}）。请明确选择是否一并移入回收站。',
        confirmBlockedNote: '其中 {n} 个会话不可删除，宿主会跳过它们。',
        confirmGcTitle: '确认回收附件',
        confirmGcBody: '将删除 {n} 个没有任何引用指向的附件对象，释放 {bytes}。此操作不可撤销。',
        confirmEmptyTitle: '确认清空回收站',
        confirmEmptyBody: '将永久删除回收站中的 {entries} 个条目（{sessions} 个会话、{bytes}）。此操作不可撤销。',
        confirmDo: '确认',
        confirmCancel: '取消',
        statusDone: '命令已完成，宿主未返回变更数量。',
        statusChanged: '命令已完成，变更 {n} 项。',
        commandFailed: '命令未执行。',
        requestFailed: '请求失败：{error}',
        skippedTitle: '已跳过 {n} 项：',
        skippedMore: '另有 {n} 项未列出。',
        unknownReason: '未知原因',
        errorsTitle: '宿主报告的错误：',
        degradedTitle: '部分宿主服务不可用，相关数值显示为未知（—）而不是 0：',
        serviceSessionQuery: '会话查询',
        serviceSessionPersistence: '会话持久化',
        serviceWorkspaceRegistry: '工作区登记',
        warningsTitle: '宿主警告：',
        footGenerated: '生成于 {time}',
      },
      en: {
        nav: 'Session admin',
        title: 'Session admin',
        intro: 'A hygiene view of session storage: the log and projection bytes each session holds, its archived and pinned state, what sits in the trash, and which attachment objects nothing references any more.',
        homeLabel: 'Home: {path}',
        refresh: 'Refresh',
        busyRefresh: 'Reading…',
        busy: 'Working…',
        back: '← Back to conversation',
        loading: 'Reading session state…',
        errorFetch: 'Could not read session state: {error}',
        errorHost: 'The host returned a failure: {error}',
        unknownHostFailure: 'unknown host failure',
        retry: 'Retry',
        cardSessions: 'Sessions',
        cardSessionsNote: 'live {live} · workspace records {records}',
        cardBytes: 'Bytes held',
        cardBytesNote: 'logs {log} · projection cache {cache} · outside the workspace account {unaccounted}',
        cardArchived: 'Archived',
        cardSubagent: 'Subagents',
        cardTrash: 'Trash',
        filterAll: 'All',
        filterArchived: 'Archived',
        filterActive: 'Not archived',
        filterSubagent: 'Subagents',
        filterDeletable: 'Deletable',
        projectAll: 'All projects',
        projectTitle: 'Filter by project',
        shownCount: 'Showing {shown} of {total} sessions',
        selectedCount: '{n} selected',
        selectAll: 'Select every filtered row',
        clearSelection: 'Clear selection',
        archive: 'Archive',
        unarchive: 'Unarchive',
        pin: 'Pin',
        unpin: 'Unpin',
        trash: 'Move to trash',
        colSession: 'Session',
        colProject: 'Project',
        colBytes: 'Size',
        colCreated: 'Created',
        colMarks: 'Marks',
        colActions: 'Actions',
        empty: 'No session matches the current filter.',
        selectRow: 'Select this session',
        bytesTitle: 'log {log} · projection cache {cache}',
        projectUnknown: 'unassigned project',
        chipArchived: 'archived',
        chipPinned: 'pinned',
        chipLive: 'LIVE',
        chipSubagent: 'subagent',
        chipUnaccounted: 'unregistered',
        chipBlocked: 'not deletable',
        chipUnknown: '—',
        unknownMark: 'Unknown: the host did not provide this, so it shows —, not 0',
        descendants: '{n} descendants',
        descendantsExpand: 'Show descendants',
        descendantsCollapse: 'Hide descendants',
        descendantsSummary: 'This session has {n} descendants, {bytes} in total.',
        descendantsTotal: 'Including itself: {bytes}.',
        descendantsCapped: 'Showing the first {n} descendants only.',
        descendantsMissing: 'This payload does not include those descendants, so only the total above is known.',
        trashHint: 'Move to trash (restorable)',
        attachTitle: 'Attachment objects',
        attachObjects: '{n} objects · {bytes}',
        attachStaged: '{n} staged · {bytes}',
        attachScan: 'Scan references',
        attachScanning: 'Scanning…',
        attachCandidates: '{n} reclaimable · {bytes}',
        attachNotScanned: 'Not scanned',
        attachNotScannedNote: 'References have not been verified, so no reclaimable count can be given — it is not 0.',
        attachNone: 'Nothing is reclaimable.',
        attachGc: 'Reclaim',
        attachGcBusy: 'Reclaiming…',
        trashTitle: 'Trash',
        trashSummary: '{entries} entries · {sessions} sessions · {bytes}',
        trashEmpty: 'The trash is empty.',
        trashCreated: 'created {time}',
        trashEntrySessions: '{n} sessions',
        restore: 'Restore',
        emptyTrash: 'Empty trash',
        confirmTrashTitle: 'Confirm moving to trash',
        confirmTrashBody: 'Moves {n} sessions ({bytes}) to the trash; trashed sessions can be restored.',
        confirmOnlyThese: 'Only these sessions',
        confirmWithDescendants: 'Together with {n} descendants',
        confirmDescendantsNote: 'The selected sessions own {n} descendants ({bytes}) in total. Choose explicitly whether they come along.',
        confirmBlockedNote: '{n} of them are not deletable and will be skipped by the host.',
        confirmGcTitle: 'Confirm reclaiming attachments',
        confirmGcBody: 'Deletes {n} attachment objects that nothing references, freeing {bytes}. This cannot be undone.',
        confirmEmptyTitle: 'Confirm emptying the trash',
        confirmEmptyBody: 'Permanently deletes {entries} trash entries ({sessions} sessions, {bytes}). This cannot be undone.',
        confirmDo: 'Confirm',
        confirmCancel: 'Cancel',
        statusDone: 'The command finished; the host reported no change count.',
        statusChanged: 'The command finished, changing {n} items.',
        commandFailed: 'The command did not run.',
        requestFailed: 'Request failed: {error}',
        skippedTitle: 'Skipped {n}:',
        skippedMore: '{n} more are not listed.',
        unknownReason: 'unknown reason',
        errorsTitle: 'Errors reported by the host:',
        degradedTitle: 'Some Host services are unavailable, so the affected figures show as unknown (—) rather than 0:',
        serviceSessionQuery: 'session query',
        serviceSessionPersistence: 'session persistence',
        serviceWorkspaceRegistry: 'workspace registry',
        warningsTitle: 'Host warnings:',
        footGenerated: 'Generated at {time}',
      },
    }
    //#endregion

    //#region styles
    const CSS = [
      // The page lives in two very different homes: the wide centre column and
      // the settings modal's narrow content column. It is its own query
      // container so the table sheds width instead of overflowing the modal.
      '.dsa-section{max-width:1000px;width:100%;min-width:0;container-type:inline-size;color:var(--dsw-alias-label-primary);flex-direction:column;gap:14px;display:flex}',
      '.dsa-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}',
      '.dsa-title{margin:0;font-size:18px;font-weight:600}',
      '.dsa-intro{color:var(--dsw-alias-label-tertiary);margin:4px 0 0;font-size:13px;line-height:20px;max-width:64ch}',
      '.dsa-home{color:var(--dsw-alias-label-tertiary);margin:2px 0 0;font-size:12px;line-height:18px;word-break:break-all}',
      '.dsa-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dsa-btn{font:inherit;font-size:13px;line-height:20px;padding:5px 12px;border-radius:6px;cursor:pointer;color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-border-l2);background:0 0}',
      '.dsa-btn:hover{border-color:var(--dsw-alias-label-tertiary)}',
      '.dsa-btn:disabled{opacity:.5;cursor:default}',
      '.dsa-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.dsa-btn[data-active=true]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}',
      '.dsa-btnDanger{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary));border-color:var(--dsw-alias-state-error-primary,var(--dsw-alias-border-l2))}',
      '.dsa-btnSm{font-size:12px;line-height:16px;padding:3px 8px}',
      '.dsa-sep{width:1px;height:18px;background:var(--dsw-alias-border-l2)}',
      '.dsa-select{font:inherit;font-size:13px;line-height:20px;padding:5px 8px;border-radius:6px;color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-border-l2);background:0 0;max-width:280px}',
      '.dsa-block{border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;min-width:0}',
      '.dsa-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}',
      '.dsa-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.dsa-cardLabel{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.dsa-cardValue{font-size:22px;font-weight:600;line-height:28px;font-variant-numeric:tabular-nums}',
      '.dsa-cardNote{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.dsa-muted{color:var(--dsw-alias-label-tertiary);font-size:13px;margin:0}',
      '.dsa-h3{margin:0;font-size:14px;font-weight:600}',
      '.dsa-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dsa-error{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary));font-size:13px;margin:0}',
      '.dsa-notice{border:.5px solid var(--dsw-alias-state-error-primary,var(--dsw-alias-border-l2));border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:6px}',
      '.dsa-status{border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:6px}',
      '.dsa-list{margin:0;padding-left:18px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.dsa-tableWrap{max-width:100%;overflow-x:auto}',
      '.dsa-table{width:100%;border-collapse:collapse;font-size:13px}',
      '.dsa-table th{color:var(--dsw-alias-label-tertiary);font-weight:500;text-align:left;padding:6px 8px;border-bottom:.5px solid var(--dsw-alias-border-l2);white-space:nowrap}',
      '.dsa-table td{padding:7px 8px;border-bottom:.5px solid var(--dsw-alias-border-l2);vertical-align:top}',
      '.dsa-table tr:last-child td{border-bottom:0}',
      '.dsa-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.dsa-clip{display:block;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsa-sessionTitle{font-weight:500}',
      '.dsa-mono{font-family:var(--ds-font-family-code,monospace);font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.dsa-link{font:inherit;font-size:11px;line-height:16px;padding:0;border:0;background:0 0;color:var(--dsw-alias-state-business-primary);cursor:pointer}',
      '.dsa-link:hover{text-decoration:underline}',
      '.dsa-chip{display:inline-block;font-size:11px;line-height:16px;padding:0 6px;margin:0 4px 2px 0;border-radius:4px;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}',
      '.dsa-chipLive{color:var(--dsw-alias-state-business-primary)}',
      '.dsa-chipBlocked{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary))}',
      '.dsa-actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}',
      '.dsa-subRow td{padding:0 8px 8px}',
      '.dsa-subBox{border-left:2px solid var(--dsw-alias-border-l2);padding:6px 0 6px 10px;display:flex;flex-direction:column;gap:4px;max-height:280px;overflow:auto}',
      '.dsa-subLine{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}',
      '.dsa-confirm{border:.5px solid var(--dsw-alias-state-error-primary,var(--dsw-alias-border-l2));border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}',
      '.dsa-confirmTitle{margin:0;font-size:13px;font-weight:600}',
      '.dsa-confirmBody{margin:0;font-size:13px;line-height:20px}',
      '.dsa-confirmActions{display:flex;gap:8px;flex-wrap:wrap}',
      '.dsa-bulk{display:flex;align-items:center;gap:8px;flex-wrap:wrap;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:8px 10px}',
      '.dsa-trashList{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}',
      '.dsa-trashItem{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}',
      '.dsa-trashMeta{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;min-width:0}',
      '.dsa-foot{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:0}',
      '.dsa-panel{box-sizing:border-box;height:100%;overflow:auto;padding:20px clamp(24px,4vw,48px) 48px}',
      '@container (max-width:760px){.dsa-clip,.dsa-sessionTitle{max-width:150px}}',
      '@container (max-width:640px){.dsa-colOptional{display:none}}',
    ].join('')

    const STYLE_ID = 'dsh-session-admin/SessionAdmin.css'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_ID) + ']') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-session-admin'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }
    //#endregion

    //#region formatting
    const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

    /**
     * Scale-suffixed byte figure, or the unknown marker.
     *
     * Every byte figure on this page goes through here, so a `null` the host
     * sent can never be mistaken for a small file: it renders as `—`.
     *
     * @param value - exact bytes from the host.
     * @returns display text, never `0 B` for an unknown value.
     */
    function byteSize(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return UNKNOWN
      const sign = value < 0 ? '-' : ''
      let size = Math.abs(value)
      let unit = 0
      while (size >= 1024 && unit < BYTE_UNITS.length - 1) {
        size /= 1024
        unit += 1
      }
      const digits = unit === 0 ? 0 : size >= 100 ? 0 : size >= 10 ? 1 : 2
      return sign + size.toFixed(digits) + ' ' + BYTE_UNITS[unit]
    }

    /** Exact count with thousands separators, or the unknown marker. */
    function count(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US') : UNKNOWN
    }

    /** Short local date-time for one host timestamp; `null` stays unknown. */
    function stamp(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return UNKNOWN
      const date = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /** Local wall-clock time for the "generated at" footer. */
    function clock(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return UNKNOWN
      const date = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    /** Substitute `{name}` placeholders in one dictionary string. */
    function fill(template, params) {
      return template.replace(/\{(\w+)/gu, (_, key) => String(params[key] ?? ''))
    }
    //#endregion

    //#region derivation
    /** Filter keys, in the order the segmented control shows them. */
    const FILTERS = ['all', 'archived', 'active', 'subagent', 'deletable']

    /** Dictionary key of each segmented filter's label. */
    const FILTER_LABELS = {
      all: 'filterAll',
      archived: 'filterArchived',
      active: 'filterActive',
      subagent: 'filterSubagent',
      deletable: 'filterDeletable',
    }

    /** Dictionary key of each command's name, for buttons and the status line. */
    const ACTION_LABELS = {
      archive: 'archive',
      unarchive: 'unarchive',
      pin: 'pin',
      unpin: 'unpin',
      trash: 'trash',
      restore: 'restore',
      emptyTrash: 'emptyTrash',
      attachmentScan: 'attachScan',
      attachmentGc: 'attachGc',
    }

    /**
     * Does one session row pass one segmented filter?
     *
     * A `null` flag means the host could not answer, so it is deliberately not
     * claimed as a subagent or as deletable: the filter means "known to be",
     * and such a row still shows its `—` marker in the table.
     *
     * @param session - one row of `state.sessions`.
     * @param filter - one key of `FILTERS`.
     */
    function matchesFilter(session, filter) {
      if (filter === 'archived') return session.archived === true
      if (filter === 'active') return session.archived !== true
      if (filter === 'subagent') return session.isSubagent === true
      if (filter === 'deletable') return session.deletable === true
      return true
    }

    /**
     * Project options for the filter row.
     *
     * The host's own project roll-up is the authority. An older host half may
     * send no roll-up at all, so the session rows are used as the fallback
     * rather than showing a select that cannot filter anything.
     *
     * @param data - the host state object.
     * @returns `{ key, label, sessions }` per project.
     */
    function projectOptions(data) {
      const projects = Array.isArray(data?.projects) ? data.projects : []
      if (projects.length > 0) {
        return projects
          // A project the host could not key cannot be filtered on: an option
          // whose value is `null` would match nothing and look broken.
          .filter((project) => project.key !== null && project.key !== undefined)
          .map((project) => ({
            key: String(project.key),
            label: typeof project.project === 'string' ? project.project : '',
            sessions: typeof project.sessions === 'number' ? project.sessions : null,
          }))
      }
      const seen = new Map()
      for (const session of data?.sessions ?? []) {
        const key = session.projectKey
        if (key === null || key === undefined || seen.has(key)) continue
        seen.set(key, {
          key: String(key),
          label: typeof session.project === 'string' ? session.project : '',
          sessions: null,
        })
      }
      return [...seen.values()]
    }

    /** Index the corpus by id, for parent lookups and cascade figures. */
    function indexById(sessions) {
      const map = new Map()
      for (const session of sessions) map.set(session.id, session)
      return map
    }

    /**
     * Is any ancestor of this row part of the same selection?
     *
     * The host reports each row's whole subtree, so a selection holding both a
     * parent and one of its descendants would otherwise count the shared
     * subtree twice. The walk is bounded by a visited set because a corrupt
     * `parentSession` chain must not hang the panel.
     */
    function hasSelectedAncestor(row, selectedIds, byId) {
      const seen = new Set([row.id])
      let parentId = row.parentSession
      while (parentId !== null && parentId !== undefined && !seen.has(parentId)) {
        if (selectedIds.has(parentId)) return true
        seen.add(parentId)
        const parent = byId.get(parentId)
        parentId = parent === undefined ? null : parent.parentSession
      }
      return false
    }

    /**
     * Descendant count and bytes a trash command would take along.
     *
     * Rows whose ancestor is also selected are skipped, because that ancestor's
     * own `descendants` figure already includes them.
     */
    function descendantTotals(rows, byId) {
      const selectedIds = new Set(rows.map((row) => row.id))
      let descendants = 0
      let descendantBytes = 0
      for (const row of rows) {
        if (!(row.descendants > 0)) continue
        if (hasSelectedAncestor(row, selectedIds, byId)) continue
        descendants += row.descendants
        descendantBytes += typeof row.descendantBytes === 'number' ? row.descendantBytes : 0
      }
      return { descendants, descendantBytes }
    }

    /**
     * Bytes one trash command frees, for the confirmation text.
     *
     * Without descendants only the selected rows' own logs and projections go,
     * and those are disjoint, so every row counts. With descendants a whole
     * subtree goes per row, so a row whose ancestor is also selected is skipped
     * — the ancestor's cascade already covers it. The host's `cascades` figures
     * win over the sums when it sent them.
     *
     * @param rows - the selected session rows.
     * @param cascadeById - `Map` of id to the host's cascade row.
     * @param byId - `Map` of the whole corpus by id, for the ancestor walk.
     * @param includeDescendants - which choice the confirmation offers.
     */
    function trashBytes(rows, cascadeById, byId, includeDescendants) {
      const selectedIds = new Set(rows.map((row) => row.id))
      let total = 0
      for (const row of rows) {
        const cascade = cascadeById.get(row.id)
        if (includeDescendants) {
          if (hasSelectedAncestor(row, selectedIds, byId)) continue
          total += cascade?.totalBytes ?? (row.bytes ?? 0) + (row.descendantBytes ?? 0)
        } else {
          total += cascade?.ownBytes ?? row.bytes ?? 0
        }
      }
      return total
    }

    /**
     * The visible part of one session's subtree.
     *
     * The host's `descendants` count is the truth; this only lists what the
     * payload actually contains, capped so one huge subtree cannot render
     * thousands of lines.
     */
    function collectDescendants(id, childIndex, cap) {
      const out = []
      const queue = [...(childIndex.get(id) ?? [])]
      const seen = new Set([id])
      while (queue.length > 0 && out.length < cap) {
        const next = queue.shift()
        if (next === undefined || seen.has(next.id)) continue
        seen.add(next.id)
        out.push(next)
        const children = childIndex.get(next.id)
        if (children !== undefined) queue.push(...children)
      }
      return out
    }
    //#endregion

    //#region panel
    const h = React.createElement

    /** How many descendant rows one expanded sub-row lists at most. */
    const DESCENDANT_CAP = 20

    /** How many skipped entries the status line spells out. */
    const SKIPPED_SHOWN = 8

    /** Host services that, when missing, turn figures into "unknown". */
    const SERVICE_KEYS = [
      ['sessionQuery', 'serviceSessionQuery'],
      ['sessionPersistence', 'serviceSessionPersistence'],
      ['workspaceRegistry', 'serviceWorkspaceRegistry'],
    ]

    /**
     * Decorative glyph for the sidebar's global-panel row.
     *
     * The shell owns the row button, its label, the tooltip and the click, and
     * renders this as the row's DIRECT icon child — wrapping it in an element
     * would break the row's glyph slot baseline.
     */
    function SessionAdminIcon({ size }) {
      const edge = typeof size === 'number' ? size : 18
      return h('svg', {
        width: edge,
        height: edge,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
        h('path', { key: 'top', d: 'M4 6.5c0-1.6 3.6-2.9 8-2.9s8 1.3 8 2.9-3.6 2.9-8 2.9-8-1.3-8-2.9Z' }),
        h('path', { key: 'body', d: 'M4 6.5v11c0 1.6 3.6 2.9 8 2.9s8-1.3 8-2.9v-11' }),
        h('path', { key: 'waist', d: 'M4 12c0 1.6 3.6 2.9 8 2.9s8-1.3 8-2.9' }),
      )
    }

    /**
     * The panel hosted by the centre column instead of the settings modal: the
     * slot outlet uses `display: contents`, so this element is a direct flex
     * child of the frame column and must own its height and scrolling. `onClose`
     * comes from this registration's inject face — the settings modal supplies
     * its own chrome instead and gets no such prop.
     */
    function SessionAdminPanel(props) {
      return h('div', { className: 'dsa-panel' }, h(SessionAdminSection, props))
    }

    /** The Settings page, and the centre-column panel: one body for both. */
    function SessionAdminSection({ t, onClose }) {
      const translate = typeof t === 'function' ? t : (key) => key
      const language = translate('nav') === DICTIONARIES.zh.nav ? 'zh' : 'en'
      const dict = DICTIONARIES[language]
      const text = React.useCallback((key, params) => fill(dict[key] ?? key, params ?? {}), [dict])

      const [state, setState] = React.useState({ status: 'loading' })
      const [filter, setFilter] = React.useState('all')
      /** `''` means "every project"; otherwise a `projectKey`. */
      const [project, setProject] = React.useState('')
      const [selected, setSelected] = React.useState(() => new Set())
      const [expanded, setExpanded] = React.useState(() => new Set())
      /** The pending two-step confirmation; only its own buttons run a command. */
      const [confirm, setConfirm] = React.useState(null)
      /** The command in flight, if any: while set, every action is disabled. */
      const [busy, setBusy] = React.useState(null)
      /** Result of the last command, kept visible until the next one starts. */
      const [report, setReport] = React.useState(null)
      const [seq, setSeq] = React.useState(0)

      React.useEffect(() => {
        let cancelled = false
        const controller = new AbortController()
        setState((prev) => ({ status: 'loading', data: prev.data, error: prev.error }))
        fetch(STATE_URL, { signal: controller.signal })
          .then((response) => response.json())
          .then((payload) => {
            if (cancelled) return
            if (payload === null || typeof payload !== 'object' || payload.ok !== true) {
              setState({
                status: 'error',
                // A host that answered `ok: false` is a different failure from a
                // request that never arrived: retry means the same thing in both
                // cases, but the diagnosis does not.
                hostFailure: payload !== null && typeof payload === 'object',
                error: payload?.error ?? text('unknownHostFailure'),
                data: payload !== null && typeof payload === 'object' ? payload : undefined,
              })
            } else {
              setState({ status: 'ready', data: payload })
            }
          })
          .catch((error) => {
            if (cancelled || error?.name === 'AbortError') return
            setState({ status: 'error', error: String(error?.message ?? error) })
          })
        return () => {
          cancelled = true
          controller.abort()
        }
      }, [seq])

      const data = state.data
      const ready = data !== undefined && data.ok === true
      const loading = state.status === 'loading'
      const working = busy !== null
      const disabled = working || loading

      const sessions = React.useMemo(() => (ready && Array.isArray(data.sessions) ? data.sessions : []), [ready, data])
      const byId = React.useMemo(() => indexById(sessions), [sessions])
      const cascadeById = React.useMemo(() => {
        const map = new Map()
        for (const cascade of (ready && Array.isArray(data.cascades) ? data.cascades : [])) map.set(cascade.id, cascade)
        return map
      }, [ready, data])
      /** Direct children per parent id, for the expandable descendant sub-row. */
      const childIndex = React.useMemo(() => {
        const map = new Map()
        for (const session of sessions) {
          const parent = session.parentSession
          if (parent === null || parent === undefined) continue
          const list = map.get(parent)
          if (list === undefined) map.set(parent, [session])
          else list.push(session)
        }
        return map
      }, [sessions])

      const filtered = React.useMemo(() => sessions.filter((session) => matchesFilter(session, filter)
        && (project === '' || session.projectKey === project)), [sessions, filter, project])
      const options = React.useMemo(() => projectOptions(data ?? {}), [data])

      // A bulk button must never mutate a row the user cannot see: whenever the
      // filtered set changes, the selection drops to what is still on screen.
      React.useEffect(() => {
        setSelected((prev) => {
          if (prev.size === 0) return prev
          const visible = new Set(filtered.map((session) => session.id))
          const next = new Set()
          for (const id of prev) if (visible.has(id)) next.add(id)
          return next.size === prev.size ? prev : next
        })
      }, [filtered])

      /**
       * Send exactly one frozen command shape and fold the host's fresh state
       * back in. The response carries the next state, so nothing re-fetches and
       * the figures on screen are the host's own, not a local guess.
       */
      function run(command) {
        setConfirm(null)
        setReport(null)
        setBusy({ action: command.action })
        fetch(ACTION_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(command),
        })
          .then((response) => response.json())
          .then((payload) => {
            if (payload === null || typeof payload !== 'object') {
              setReport({ ok: false, message: '', requestError: text('unknownHostFailure'), skipped: [], errors: [], action: command.action })
              return
            }
            const next = payload.state
            if (next !== null && typeof next === 'object' && next.ok === true) setState({ status: 'ready', data: next })
            setReport({
              ok: payload.ok === true,
              message: typeof payload.message === 'string' ? payload.message : '',
              changed: typeof payload.changed === 'number' ? payload.changed : null,
              skipped: Array.isArray(payload.skipped) ? payload.skipped : [],
              errors: Array.isArray(payload.errors) ? payload.errors : [],
              action: typeof payload.action === 'string' ? payload.action : command.action,
            })
          })
          .catch((error) => {
            setReport({
              ok: false,
              message: '',
              requestError: String(error?.message ?? error),
              skipped: [],
              errors: [],
              action: command.action,
            })
          })
          .finally(() => setBusy(null))
      }

      /** Name one command in the current language, falling back to its raw id. */
      const actionLabel = (action) => text(ACTION_LABELS[action] ?? String(action))

      /**
       * Open the inline trash confirmation for a set of rows — this never fires
       * the command itself, and it never assumes descendants come along.
       */
      function askTrash(rows) {
        if (rows.length === 0) return
        const totals = descendantTotals(rows, byId)
        setConfirm({
          kind: 'trash',
          ids: rows.map((row) => row.id),
          descendants: totals.descendants,
          descendantBytes: totals.descendantBytes,
          blocked: rows.filter((row) => row.deletable === false).length,
          onlyBytes: trashBytes(rows, cascadeById, byId, false),
          withBytes: trashBytes(rows, cascadeById, byId, true),
        })
      }

      function toggleRow(id) {
        setSelected((prev) => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }

      /** Check or clear every row the current filter shows, never hidden ones. */
      function toggleAll() {
        setSelected((prev) => {
          const visible = filtered.map((session) => session.id)
          const all = visible.length > 0 && visible.every((id) => prev.has(id))
          const next = new Set(prev)
          for (const id of visible) {
            if (all) next.delete(id)
            else next.add(id)
          }
          return next
        })
      }

      function toggleExpanded(id) {
        setExpanded((prev) => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }

      /** One action button; `options.title` explains a refused control. */
      const actionButton = (key, label, onClick, options = {}) => h('button', {
        key,
        type: 'button',
        className: 'dsa-btn'
          + (options.danger === true ? ' dsa-btnDanger' : '')
          + (options.small === true ? ' dsa-btnSm' : ''),
        disabled: options.disabled === true,
        title: options.title,
        onClick,
      }, label)

      const selectedIds = [...selected]
      const selectedRows = selectedIds.map((id) => byId.get(id)).filter((row) => row !== undefined)

      const corpus = data?.corpus ?? {}
      const archived = corpus.archived ?? {}
      const trash = data?.trash !== undefined && data.trash !== null ? data.trash : { entries: [], bytes: 0 }
      const attachments = data?.attachments ?? {}
      const missingServices = ready
        ? SERVICE_KEYS.filter(([flag]) => (data.services ?? {})[flag] !== true)
        : []

      const header = h('div', { className: 'dsa-head' },
        h('div', null,
          h('h2', { className: 'dsa-title' }, text('title')),
          h('p', { className: 'dsa-intro' }, text('intro')),
          h('p', { className: 'dsa-home', title: typeof data?.home === 'string' ? data.home : undefined },
            text('homeLabel', { path: typeof data?.home === 'string' ? data.home : UNKNOWN })),
        ),
        h('div', { className: 'dsa-controls' },
          typeof onClose === 'function' ? actionButton('close', text('back'), onClose) : null,
          actionButton('refresh', loading ? text('busyRefresh') : text('refresh'), () => setSeq((prev) => prev + 1), { disabled: working || loading }),
        ),
      )

      const notices = []
      if (missingServices.length > 0) {
        notices.push(h('div', { className: 'dsa-status', key: 'degraded' },
          h('p', { className: 'dsa-muted' }, text('degradedTitle')),
          h('ul', { className: 'dsa-list' }, missingServices.map(([, labelKey]) => h('li', { key: labelKey }, text(labelKey)))),
        ))
      }
      if (ready && Array.isArray(data.warnings) && data.warnings.length > 0) {
        notices.push(h('div', { className: 'dsa-status', key: 'warnings' },
          h('p', { className: 'dsa-muted' }, text('warningsTitle')),
          h('ul', { className: 'dsa-list' }, data.warnings.map((warning, index) => h('li', { key: String(index) }, String(warning)))),
        ))
      }
      if (working || report !== null) {
        const lines = []
        if (working) lines.push(h('p', { className: 'dsa-muted', key: 'busy' }, text('busy') + ' · ' + actionLabel(busy.action)))
        if (report !== null) {
          const line = report.requestError !== undefined
            ? text('requestFailed', { error: report.requestError })
            : report.message !== ''
              ? (report.ok ? report.message : text('commandFailed') + ' ' + report.message)
              : report.ok
                ? (report.changed === null ? text('statusDone') : text('statusChanged', { n: report.changed }))
                : text('commandFailed')
          const prefix = actionLabel(report.action) + (language === 'zh' ? '：' : ': ')
          lines.push(h('p', { className: report.ok ? 'dsa-muted' : 'dsa-error', key: 'line' }, prefix + line))
          if (!report.ok && report.errors.length > 0) {
            lines.push(h('p', { className: 'dsa-error', key: 'errorsTitle' }, text('errorsTitle')))
            lines.push(h('ul', { className: 'dsa-list', key: 'errors' },
              report.errors.map((error, index) => h('li', { key: String(index) }, String(error)))))
          }
          if (report.skipped.length > 0) {
            lines.push(h('p', { className: 'dsa-muted', key: 'skippedTitle' }, text('skippedTitle', { n: report.skipped.length })))
            lines.push(h('ul', { className: 'dsa-list', key: 'skipped' },
              report.skipped.slice(0, SKIPPED_SHOWN).map((skipped, index) => h('li', { key: String(skipped?.id ?? index) },
                h('span', { className: 'dsa-mono' }, String(skipped?.id ?? UNKNOWN)),
                ' — ' + String(skipped?.reason ?? text('unknownReason'))))))
            if (report.skipped.length > SKIPPED_SHOWN) {
              lines.push(h('p', { className: 'dsa-muted', key: 'skippedMore' }, text('skippedMore', { n: report.skipped.length - SKIPPED_SHOWN })))
            }
          }
        }
        notices.push(h('div', { className: 'dsa-status', key: 'report' }, lines))
      }

      const body = []

      if (!ready) {
        if (state.status === 'error') {
          body.push(h('div', { className: 'dsa-notice', key: 'error' },
            h('p', { className: 'dsa-error' }, text(state.hostFailure === true ? 'errorHost' : 'errorFetch', {
              error: String(state.error ?? text('unknownHostFailure')),
            })),
            h('div', { className: 'dsa-row' },
              actionButton('retry', text('retry'), () => setSeq((prev) => prev + 1), { disabled: loading })),
          ))
        } else {
          body.push(h('p', { className: 'dsa-muted', key: 'loading' }, text('loading')))
        }
      }

      if (ready) {
        /** One stat card: label, the figure, and the note that qualifies it. */
        const card = (key, label, value, note, title) => h('div', { className: 'dsa-card', key },
          h('span', { className: 'dsa-cardLabel' }, label),
          h('span', { className: 'dsa-cardValue', title }, value),
          h('span', { className: 'dsa-cardNote' }, note),
        )
        // The corpus total is the two stores the host always measures. A host
        // that omitted either number must show "unknown" rather than a sum that
        // silently treats the missing half as zero.
        const corpusBytes = typeof corpus.logBytes === 'number' && typeof corpus.cacheBytes === 'number'
          ? corpus.logBytes + corpus.cacheBytes
          : null
        const entries = Array.isArray(trash.entries) ? trash.entries : []

        body.push(h('div', { className: 'dsa-cards', key: 'cards' },
          card('sessions', text('cardSessions'), count(corpus.sessions),
            text('cardSessionsNote', { live: count(corpus.live), records: count(corpus.workspaceRecords) })),
          card('bytes', text('cardBytes'), byteSize(corpusBytes),
            text('cardBytesNote', {
              log: byteSize(corpus.logBytes),
              cache: byteSize(corpus.cacheBytes),
              unaccounted: byteSize(corpus.unaccounted?.bytes),
            }),
            typeof corpusBytes === 'number' ? count(corpusBytes) + ' B' : undefined),
          card('archived', text('cardArchived'), count(archived.count), byteSize(archived.bytes),
            typeof archived.bytes === 'number' ? count(archived.bytes) + ' B' : undefined),
          card('subagent', text('cardSubagent'), count(corpus.subagent), byteSize(corpus.subagentBytes),
            typeof corpus.subagentBytes === 'number' ? count(corpus.subagentBytes) + ' B' : undefined),
          card('trash', text('cardTrash'), count(entries.length), byteSize(trash.bytes),
            typeof trash.bytes === 'number' ? count(trash.bytes) + ' B' : undefined),
        ))

        body.push(h('div', { className: 'dsa-row', key: 'filters' },
          FILTERS.map((key) => h('button', {
            key,
            type: 'button',
            className: 'dsa-btn',
            'data-active': filter === key ? 'true' : 'false',
            disabled: loading,
            onClick: () => setFilter(key),
          }, text(FILTER_LABELS[key]))),
          h('span', { className: 'dsa-sep' }),
          h('select', {
            className: 'dsa-select',
            value: project,
            title: text('projectTitle'),
            'aria-label': text('projectTitle'),
            disabled: loading,
            onChange: (event) => setProject(event.target.value),
          }, [
            h('option', { key: '__all__', value: '' }, text('projectAll')),
            ...options.map((option) => h('option', { key: option.key, value: option.key },
              (option.label !== '' ? option.label : text('projectUnknown'))
              + (option.sessions === null ? '' : ' (' + option.sessions + ')'))),
          ]),
          h('span', { className: 'dsa-muted' }, text('shownCount', { shown: filtered.length, total: sessions.length })),
        ))

        if (selectedIds.length > 0) {
          body.push(h('div', { className: 'dsa-bulk', key: 'bulk' },
            h('span', { className: 'dsa-cardLabel' }, text('selectedCount', { n: selectedIds.length })),
            actionButton('bulkArchive', text('archive'),
              () => run({ action: 'archive', sessionIds: selectedIds }), { disabled, small: true }),
            actionButton('bulkUnarchive', text('unarchive'),
              () => run({ action: 'unarchive', sessionIds: selectedIds }), { disabled, small: true }),
            actionButton('bulkPin', text('pin'),
              () => run({ action: 'pin', sessionIds: selectedIds }), { disabled, small: true }),
            actionButton('bulkUnpin', text('unpin'),
              () => run({ action: 'unpin', sessionIds: selectedIds }), { disabled, small: true }),
            actionButton('bulkTrash', text('trash'),
              () => askTrash(selectedRows), { disabled, small: true, danger: true, title: text('trashHint') }),
            actionButton('bulkClear', text('clearSelection'),
              () => setSelected(new Set()), { disabled: working, small: true }),
          ))
        }

        if (confirm !== null && confirm.kind === 'trash') {
          // The two options exist only when the host reports descendants: the
          // panel must never decide on its own that they come along.
          body.push(h('div', { className: 'dsa-confirm', key: 'confirmTrash' },
            h('p', { className: 'dsa-confirmTitle' }, text('confirmTrashTitle')),
            h('p', { className: 'dsa-confirmBody' },
              text('confirmTrashBody', { n: confirm.ids.length, bytes: byteSize(confirm.onlyBytes) })),
            confirm.descendants > 0
              ? h('p', { className: 'dsa-muted' },
                text('confirmDescendantsNote', { n: confirm.descendants, bytes: byteSize(confirm.descendantBytes) }))
              : null,
            confirm.blocked > 0
              ? h('p', { className: 'dsa-muted' }, text('confirmBlockedNote', { n: confirm.blocked }))
              : null,
            h('div', { className: 'dsa-confirmActions' },
              confirm.descendants > 0
                ? actionButton('only', text('confirmOnlyThese') + ' · ' + byteSize(confirm.onlyBytes),
                  () => run({ action: 'trash', sessionIds: confirm.ids, includeDescendants: false }), { disabled: working })
                : actionButton('do', text('confirmDo') + ' · ' + byteSize(confirm.onlyBytes),
                  () => run({ action: 'trash', sessionIds: confirm.ids, includeDescendants: false }), { disabled: working, danger: true }),
              confirm.descendants > 0
                ? actionButton('with', text('confirmWithDescendants', { n: confirm.descendants }) + ' · ' + byteSize(confirm.withBytes),
                  () => run({ action: 'trash', sessionIds: confirm.ids, includeDescendants: true }), { disabled: working, danger: true })
                : null,
              actionButton('cancel', text('confirmCancel'), () => setConfirm(null), { disabled: working }),
            ),
          ))
        }

        const allVisibleSelected = filtered.length > 0 && filtered.every((session) => selected.has(session.id))
        const tableRows = []
        for (const session of filtered) {
          const isOpen = expanded.has(session.id)
          const marks = []
          if (session.archived === true) marks.push(h('span', { key: 'archived', className: 'dsa-chip' }, text('chipArchived')))
          if (session.pinned === true) marks.push(h('span', { key: 'pinned', className: 'dsa-chip' }, text('chipPinned')))
          if (session.live === true) marks.push(h('span', { key: 'live', className: 'dsa-chip dsa-chipLive' }, text('chipLive')))
          if (session.isSubagent === true) marks.push(h('span', { key: 'subagent', className: 'dsa-chip' }, text('chipSubagent')))
          // One marker for every figure the host could not answer, so a row
          // never looks like "not live" when it really is "unknown".
          if (session.live === null || session.live === undefined
            || session.isSubagent === null || session.isSubagent === undefined) {
            marks.push(h('span', { key: 'unknown', className: 'dsa-chip', title: text('unknownMark') }, text('chipUnknown')))
          }
          if (session.inWorkspaceAccount === false) marks.push(h('span', { key: 'unaccounted', className: 'dsa-chip' }, text('chipUnaccounted')))
          const blockedReason = typeof session.blockedReason === 'string' && session.blockedReason !== ''
            ? session.blockedReason
            : text('chipBlocked')
          if (session.deletable === false) {
            marks.push(h('span', { key: 'blocked', className: 'dsa-chip dsa-chipBlocked', title: blockedReason }, text('chipBlocked')))
          }

          const identity = []
          const hasTitle = typeof session.title === 'string' && session.title !== ''
          if (hasTitle) {
            identity.push(h('span', { key: 'title', className: 'dsa-clip dsa-sessionTitle', title: session.title }, session.title))
          }
          identity.push(h('span', { key: 'id', className: 'dsa-mono dsa-clip', title: session.id }, session.id))
          if (session.descendants > 0) {
            identity.push(h('button', {
              key: 'descendants',
              type: 'button',
              className: 'dsa-link',
              'aria-expanded': isOpen ? 'true' : 'false',
              title: text(isOpen ? 'descendantsCollapse' : 'descendantsExpand'),
              onClick: () => toggleExpanded(session.id),
            }, (isOpen ? '▾ ' : '▸ ') + text('descendants', { n: session.descendants })))
          }

          const archivedNow = session.archived === true
          const pinnedNow = session.pinned === true
          tableRows.push(h('tr', { key: session.id },
            h('td', null, h('input', {
              type: 'checkbox',
              checked: selected.has(session.id),
              title: text('selectRow'),
              'aria-label': text('selectRow'),
              onChange: () => toggleRow(session.id),
            })),
            h('td', null, identity),
            h('td', { className: 'dsa-colOptional' },
              h('span', { className: 'dsa-clip', title: session.project ?? undefined },
                typeof session.project === 'string' && session.project !== '' ? session.project : text('projectUnknown'))),
            h('td', {
              className: 'dsa-num',
              title: text('bytesTitle', { log: byteSize(session.logBytes), cache: byteSize(session.cacheBytes) }),
            }, byteSize(session.bytes)),
            h('td', { className: 'dsa-colOptional' }, stamp(session.createdAt)),
            h('td', null, marks.length > 0 ? marks : h('span', { className: 'dsa-mono' }, UNKNOWN)),
            h('td', null, h('div', { className: 'dsa-actions' },
              actionButton('archive', text(archivedNow ? 'unarchive' : 'archive'),
                () => run({ action: archivedNow ? 'unarchive' : 'archive', sessionIds: [session.id] }),
                { disabled, small: true }),
              actionButton('pin', text(pinnedNow ? 'unpin' : 'pin'),
                () => run({ action: pinnedNow ? 'unpin' : 'pin', sessionIds: [session.id] }),
                { disabled, small: true }),
              actionButton('trash', text('trash'), () => askTrash([session]), {
                disabled: disabled || session.deletable === false,
                small: true,
                danger: true,
                title: session.deletable === false ? blockedReason : text('trashHint'),
              }),
            )),
          ))

          if (isOpen) {
            const shown = collectDescendants(session.id, childIndex, DESCENDANT_CAP)
            const ownBytes = typeof session.bytes === 'number' ? session.bytes : 0
            const descendantBytes = typeof session.descendantBytes === 'number' ? session.descendantBytes : 0
            tableRows.push(h('tr', { key: session.id + ':descendants', className: 'dsa-subRow' },
              h('td', { colSpan: 7 },
                h('div', { className: 'dsa-subBox' },
                  h('p', { className: 'dsa-muted' },
                    text('descendantsSummary', { n: session.descendants, bytes: byteSize(session.descendantBytes) })),
                  h('p', { className: 'dsa-muted' }, text('descendantsTotal', { bytes: byteSize(ownBytes + descendantBytes) })),
                  shown.map((child) => h('div', { className: 'dsa-subLine', key: child.id },
                    h('span', { className: 'dsa-mono dsa-clip', title: child.id }, child.id),
                    h('span', { className: 'dsa-muted' }, byteSize(child.bytes)),
                    child.archived === true ? h('span', { className: 'dsa-chip' }, text('chipArchived')) : null,
                  )),
                  shown.length === 0 ? h('p', { className: 'dsa-muted' }, text('descendantsMissing')) : null,
                  shown.length > 0 && shown.length < session.descendants
                    ? h('p', { className: 'dsa-muted' }, text('descendantsCapped', { n: shown.length }))
                    : null,
                ),
              ),
            ))
          }
        }

        body.push(filtered.length === 0
          ? h('p', { className: 'dsa-muted', key: 'table' }, text('empty'))
          : h('div', { className: 'dsa-tableWrap', key: 'table' },
            h('table', { className: 'dsa-table' },
              h('thead', null, h('tr', null,
                h('th', null, h('input', {
                  type: 'checkbox',
                  checked: allVisibleSelected,
                  disabled: filtered.length === 0,
                  title: text('selectAll'),
                  'aria-label': text('selectAll'),
                  onChange: toggleAll,
                })),
                h('th', null, text('colSession')),
                h('th', { className: 'dsa-colOptional' }, text('colProject')),
                h('th', null, text('colBytes')),
                h('th', { className: 'dsa-colOptional' }, text('colCreated')),
                h('th', null, text('colMarks')),
                h('th', null, text('colActions')),
              )),
              h('tbody', null, tableRows),
            )))
      }

      if (ready) {
        const verified = attachments.verified === true
        const candidates = typeof attachments.candidates === 'number' ? attachments.candidates : 0
        body.push(h('div', { className: 'dsa-block', key: 'attachments' },
          h('h3', { className: 'dsa-h3' }, text('attachTitle')),
          h('p', { className: 'dsa-muted' },
            text('attachObjects', { n: count(attachments.objects), bytes: byteSize(attachments.objectsBytes) })
            + ' · ' + text('attachStaged', { n: count(attachments.staged), bytes: byteSize(attachments.stagedBytes) })),
          h('div', { className: 'dsa-row' },
            actionButton('scan', working && busy.action === 'attachmentScan' ? text('attachScanning') : text('attachScan'),
              () => run({ action: 'attachmentScan' }), { disabled }),
            verified
              ? actionButton('gc', working && busy.action === 'attachmentGc' ? text('attachGcBusy') : text('attachGc'),
                () => setConfirm({
                  kind: 'attachmentGc',
                  candidates,
                  bytes: typeof attachments.candidateBytes === 'number' ? attachments.candidateBytes : 0,
                }),
                { disabled: disabled || candidates === 0, danger: true })
              : null,
          ),
          // An unverified scan is "not scanned", never "0 reclaimable": the two
          // mean opposite things to anyone deciding whether to run a GC.
          verified
            ? (candidates > 0
              ? h('p', { className: 'dsa-muted' },
                text('attachCandidates', { n: count(candidates), bytes: byteSize(attachments.candidateBytes) }))
              : h('p', { className: 'dsa-muted' }, text('attachNone')))
            : h('p', { className: 'dsa-muted' }, text('attachNotScanned') + ' — ' + text('attachNotScannedNote')),
          confirm !== null && confirm.kind === 'attachmentGc'
            ? h('div', { className: 'dsa-confirm' },
              h('p', { className: 'dsa-confirmTitle' }, text('confirmGcTitle')),
              h('p', { className: 'dsa-confirmBody' },
                text('confirmGcBody', { n: count(confirm.candidates), bytes: byteSize(confirm.bytes) })),
              h('div', { className: 'dsa-confirmActions' },
                actionButton('gcDo', text('confirmDo'),
                  () => run({ action: 'attachmentGc', confirm: true }), { disabled: working, danger: true }),
                actionButton('gcCancel', text('confirmCancel'), () => setConfirm(null), { disabled: working }),
              ),
            )
            : null,
        ))

        const trashEntries = Array.isArray(trash.entries) ? trash.entries : []
        const trashSessions = trashEntries.reduce(
          (sum, entry) => sum + (typeof entry.sessions === 'number' ? entry.sessions : 0), 0)
        body.push(h('div', { className: 'dsa-block', key: 'trash' },
          h('h3', { className: 'dsa-h3' }, text('trashTitle')),
          h('p', { className: 'dsa-muted' }, text('trashSummary', {
            entries: count(trashEntries.length),
            sessions: count(trashSessions),
            bytes: byteSize(trash.bytes),
          })),
          trashEntries.length === 0
            ? h('p', { className: 'dsa-muted' }, text('trashEmpty'))
            : h('ul', { className: 'dsa-trashList' }, trashEntries.map((entry) => h('li', {
              key: String(entry.id),
              className: 'dsa-trashItem',
            },
              h('div', { className: 'dsa-trashMeta' },
                // The tooltip lists the sessions inside, so "restore" states
                // exactly what comes back before it is clicked.
                h('span', {
                  className: 'dsa-mono dsa-clip',
                  title: Array.isArray(entry.sessionIds) ? entry.sessionIds.join('\n') : String(entry.id),
                }, String(entry.id)),
                h('span', { className: 'dsa-muted' }, text('trashCreated', { time: stamp(entry.createdAt) })),
                h('span', { className: 'dsa-muted' }, text('trashEntrySessions', { n: count(entry.sessions) })),
                h('span', { className: 'dsa-muted' }, byteSize(entry.bytes)),
              ),
              actionButton('restore', text('restore'),
                () => run({ action: 'restore', entryIds: [entry.id] }), { disabled, small: true }),
            ))),
          h('div', { className: 'dsa-row' },
            actionButton('emptyTrash', text('emptyTrash'), () => setConfirm({
              kind: 'emptyTrash',
              entries: trashEntries.length,
              sessions: trashSessions,
              bytes: typeof trash.bytes === 'number' ? trash.bytes : 0,
            }), { disabled: disabled || trashEntries.length === 0, danger: true }),
          ),
          confirm !== null && confirm.kind === 'emptyTrash'
            ? h('div', { className: 'dsa-confirm' },
              h('p', { className: 'dsa-confirmTitle' }, text('confirmEmptyTitle')),
              h('p', { className: 'dsa-confirmBody' }, text('confirmEmptyBody', {
                entries: count(confirm.entries),
                sessions: count(confirm.sessions),
                bytes: byteSize(confirm.bytes),
              })),
              h('div', { className: 'dsa-confirmActions' },
                actionButton('emptyDo', text('confirmDo'),
                  () => run({ action: 'emptyTrash', confirm: true }), { disabled: working, danger: true }),
                actionButton('emptyCancel', text('confirmCancel'), () => setConfirm(null), { disabled: working }),
              ),
            )
            : null,
        ))
      }

      return h('div', { className: 'dsa-section' },
        header,
        ...notices,
        ...body,
        ready ? h('p', { className: 'dsa-foot' }, text('footGenerated', { time: clock(data.generatedAt) })) : null,
      )
    }
    //#endregion

    //#region activation
    /** The slot registry is the page's purpose; locale gives it translated text. */
    const inject = ['slots', 'locale']

    /**
     * Register the Settings page, the sidebar row and the panel it opens.
     *
     * @param ctx - client context carrying the slot and locale registries.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => {
        try {
          return ctx.locale.register(NS, DICTIONARIES)
        } catch (error) {
          // A failed dictionary leaves keys visible but must never abort the page
          // boot, which is what an escaping apply throw would do.
          console.error('dsh-session-admin: locale registration failed', error)
          return () => {}
        }
      }, 'dsh-session-admin: dictionaries')

      ctx.slots.inject(SECTION, () => ctx.slots.register({
        name: SECTION,
        id: PANEL_ID,
        order: 46,
        label: () => t('nav'),
        locale: NS,
      }, SessionAdminSection))

      // The sidebar row and the panel it opens are registered together with the
      // same id: the shell's row button calls `selectPanel(id)`, and the layout
      // throws if no `main` entry claims that key.
      ctx.slots.inject(MAIN, () => ctx.slots.register({
        name: MAIN,
        key: PANEL_ID,
        locale: NS,
        // `layout` is read optionally rather than declared in `inject`: a missing
        // service would leave this fiber pending and abort the whole page boot,
        // which a "back" button must never be able to cause.
        inject: () => ({ onClose: () => ctx.get('layout')?.selectPanel(null) }),
      }, SessionAdminPanel))

      ctx.slots.inject(PANELLIST, () => ctx.slots.register({
        name: PANELLIST,
        id: PANEL_ID,
        order: 60,
        label: () => t('nav'),
        locale: NS,
      }, SessionAdminIcon))
    }
    //#endregion

    // Exported so the derivations can be exercised in Node without a browser;
    // only `apply`/`inject` matter to the slot renderer.
    exports.SessionAdminSection = SessionAdminSection
    exports.SessionAdminPanel = SessionAdminPanel
    exports.SessionAdminIcon = SessionAdminIcon
    exports.PANEL_ID = PANEL_ID
    exports.STATE_URL = STATE_URL
    exports.ACTION_URL = ACTION_URL
    exports.byteSize = byteSize
    exports.matchesFilter = matchesFilter
    exports.projectOptions = projectOptions
    exports.descendantTotals = descendantTotals
    exports.trashBytes = trashBytes
    exports.collectDescendants = collectDescendants
    exports.DICTIONARIES = DICTIONARIES
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
