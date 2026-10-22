# dsh-session-admin

一个 DSH 插件：审计会话存储在磁盘上到底占了什么，并提供一个可以直接管理会话的面板。

它由两半组成。宿主半边注册工具 **`session_admin`** 和一对 HTTP JSON 路由；客户端半边把管理面板渲染到中栏主区域、侧边栏图标和设置页。审计覆盖会话日志、投影缓存、`workspace.json` 里的归档/置顶集合、以及内容寻址的附件仓库。

> **一条贯穿始终的原则：先能核对，再动手。**
> 归档只是往 `workspace.json` 的 `archivedSessionIds` 里加一个 id，日志一个字节都不动；而 DSH 没有任何 Service 能列出这个集合，也没有任何 Service 能删会话。「清理归档会话」因此没有 API 可调、没有单一事实来源可查——所以这个插件先建立一份可核对的报告，再在此之上提供操作。删除也做成可逆的（见「回收站」）。

## 它回答的问题

- 归档会话的真实体积（日志 + 缓存），以及它们是不是还活着；
- **归档会话带了多少子会话**。这是最影响"清理"含义的一项：归档不连带处理子会话，而子会话通常没有自己的工作区登记、只能通过父会话到达。在一次真实语料上实测：**10 个归档会话中有 6 个带子会话，共 38 个**——只删那些父会话的日志，这 38 个就会变成谁也到不了的孤儿，却仍占满磁盘。含子会话在内的真实清理量约为"只看归档列表"的两倍；
- **语料里有多少是委派子会话**。这个比例通常远超直觉：同一次实测中 **139 个会话里有 116 个是子会话**（`origin: 'subagent'`、`delegationDepth: 1`），占会话日志字节约 **62%**，顶层会话只有 23 个；
- 哪些会话**真的在侧边栏里到不了**（不在任何工作区的 `sessionIds` 里，`cwd` 也不对应任何已登记工作区，且**不是委派子会话**）；
- 磁盘上的语料和 `sessionPersistence` / `workspaceRegistry` 两套视图在哪里对不上——对不上的地方正是清理会出意外的地方；
- 附件仓库里哪些对象**已经没有任何会话引用**，能回收多少。

> **一个被实测推翻的早期结论**
> 本插件最初把「不在工作区 `sessionIds` 里」直接表述为「侧边栏到不了」，于是同一份语料在缺少会话服务时报 112 个、装齐服务后报 0 个。原因就是子会话：它们通常也不在工作区登记里，但可以通过父会话到达。磁盘侧扫描读不到 header，**无法**区分这两者。
>
> 现在这条规则的执行方式变了，而且是同一条规则的两处应用：只有在 `sessionQuery` 可用、因而能真正判定可达性时，报告才使用「到不了」的措辞；否则标题降级为「不在工作区登记里的会话（缺少会话服务，无法判断可达性）」，并明确说明该数字是**上限**。同理，级联检查在缺少服务时会显式声明「**没有**检查归档会话是否带子会话」，而不是静默略过——静默略过会被读成「没有归档会话带子会话」。两条都有测试钉住。

## 安装

需要一个能跑 `plugin_manager` 的 DSH 安装，以及本仓库的一份检出。两种方式等价：

- 通过插件管理器：让 DSH 里的 agent 调 `plugin_manager` 的 `install_bundle`，目标指向本仓库目录；或在 Web 的 **设置 → Plugins** 页面操作。
- 手动：把本包目录加为该 profile 的依赖（包管理器会写成 `link:`），并把它列进 profile `package.json` 的 `dsh.profile.bundles`。

注册只有两处声明：profile 用 `link:` 指向本目录（因此加载的是检出目录里的代码），`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`（其中只插入一行宿主半边）；客户端半边不需要自己的行——模块扫描器通过同文件里的 `dsh.client` 声明与 `exports["./client"]` 找到它，作为同一个插件的一部分提供。因此 `package.json` 必须同时保留 `dsh.bundle.patch` 与 `dsh.client`，且 `exports["./client"]` 要指向一个真实存在的文件。

## 用法

装好后模型就能调用 `session_admin`。参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `action` | `report` | `report` 会话存储审计；`attachments` 附件仓库审计 |
| `home` | `$DSH_HOME` → `~/.dsh` | 要审计的 DSH home；不像 home 的候选会被拒绝，而不是报出一份关于空的报告 |
| `limit` | `15` | 每个列表最多几行 |
| `full` | `false` | 列出全部行 |
| `deep` | `false` | `attachments` 专用：读遍所有会话日志做引用计数 |
| `gc` | `false` | `attachments` 专用：真正删除无引用对象（要求 `deep` 且 `confirm`） |
| `confirm` | `false` | `gc` 的显式确认；不传则 `gc` 只报告 |
| `graceMinutes` | `60` | 修改时间在这个窗口内的对象永不回收 |
| `olderThanDays` | — | 只考虑闲置至少这么多天的对象 |

不进 DSH 也能跑：宿主半边只用 `ctx.get(...)` 可选地取三个服务，全都不在时报告会明确标注哪些列「未知」，而不是填 0。

```bash
DSH_HOME=~/.dsh node tools/audit.mjs                 # 只读会话审计
DSH_HOME=~/.dsh node tools/audit.mjs --action attachments --deep
DSH_HOME=~/.dsh node tools/audit.mjs --full --json
```

## 管理面板（UI）

装上后会出现在三个地方，都由客户端半边注册，**同一个 id `session-admin` 串起来**：

| 位置 | 槽 | 作用 |
| --- | --- | --- |
| 侧边栏图标 | `sidebar.panellist` | 点开即把面板切到中栏主区域 |
| 中栏主面板 | `main`（`key` 必须等于那个 id） | 完整的会话管理界面 |
| 设置页 | `settings.section` | 同一套内容的设置页入口 |

面板能做的事：按项目分组浏览会话（体积 / 创建时间 / 归档 / 置顶 / LIVE / 子会话 / 未登记标记）、筛选、多选批量归档与置顶、把会话**移入回收站**、还原、清空回收站、附件引用计数与回收。

### 数据通道

一对同源 HTTP JSON 路由，而不是生成的 Remote——这样客户端半边不需要代码生成，也不用引入任何 DSH 内部包：

```
GET  /session-admin/state     -> 完整状态（每个会话的体积、标记、子孙数，以及回收站与附件）
POST /session-admin/action    -> { action, ... } 执行一条命令，返回 message/skipped/errors 与**新状态**
```

命令返回里直接带新状态，面板不必再取一次，因此不会出现"操作成功了但表格还是旧的"。

### 删除是可逆的：回收站

这是本插件最重要的设计决定。DSH 没有删除会话的 API，删除就是对一份追加式日志做裸文件操作——**不可逆，且没有事务可依靠**。所以面板里点"删除"不会删任何东西：

- 会话被**移动**到 `<home>/session-admin-trash/<条目>/`（同卷 `rename`，原子，不重写数据）；
- 还原就是移回去；只有"清空回收站"才真正销毁字节，且需要二次确认；
- 回收站放在 `sessions/` 的**兄弟目录**，不在其中：`session-persistence-jsonl` 只枚举它配置的单一根下的 `<projectKey>/<sessionId>`，所以被隔离的会话对宿主的所有扫描器都不可见——既不会被列出，也不会被恢复或索引。

两条保护：还原时**绝不覆盖**已存在的同名会话（会话 id 可能被重新创建，覆盖会为了复活旧日志而毁掉新日志）；移动前逐条复核 `live` 状态与日志是否存在，失败的会话逐条报告原因，而不是整批失败。

### 确认规则

移入回收站、附件回收、清空回收站都必须经过面板内联的二次确认（不是 `window.confirm`），并写明将要发生什么、涉及多少字节。**带子会话的会话必须显式选择**「仅这些会话」还是「连同 N 个子会话」——绝不静默默认包含。

## 会话在一个 DSH 安装里占哪几处

| 位置 | 内容 | 删会话时 |
| --- | --- | --- |
| `<home>/sessions/<projectKey>/<sessionId>/session.v4.jsonl.zstd` | 会话日志本身 | 必须删，否则语料里仍有这个会话 |
| `<home>/storages/session_projcache/sessions/<sessionId>.json` | 投影缓存（派生物） | 必须删；只剩它会变成缓存孤儿 |
| `<home>/storages/workspace.json` | `global.archivedSessionIds`、`global.pinnedSessionIds`、各工作区的 `sessionIds` | 归档/置顶集合里的 id 必须摘掉，否则留下悬挂引用 |
| `<home>/attachments/v1/objects/<前2位>/<64位hex>` | 内容寻址的附件对象，**跨会话共享** | 不能按会话删；只能对剩余语料做引用计数后回收 |
| `<home>/cache/attachments/request-images/**` | 请求图片缓存，可再生 | 可整体清空，与会话无关 |

`projectKey` 是 `cwd` 的**有损**编码（`\` 和 `:` 都变成 `-`），所以从目录名反推路径是不可能的——`deepseek-harness\default-workspace` 和字面含 `deepseek\harness` 的路径编码相同。本插件因此从不「解码」它，只有在拿到会话 header 时才用 `cwd`。

### 为什么不自己解析日志

`session.v4.jsonl.zstd` 不是单个 zstd 流：它是**明文与 zstd 帧混排**的追加式容器，`zstdDecompressSync` 和流式解码器都只吐出第一帧（实测：2.36 MB 的文件只解出 243 字节的 header）。格式是私有的、会变的，自己解析只会得到静默错误的引用计数——而引用计数错误会直接导致附件被误删。所以引用计数走 `ctx.sessionQuery.observeSession()`，让 DSH 自己解码；每条 observation 都是租约，用完立即释放（查询服务缓存容量有限，不释放会永久钉住整份已解析日志）。

## 开发与重载

结论先行：**HMR 可以在代码层面打开；打开之后，改宿主半边不需要重启。** 出厂默认只热重载配置、不热重载代码。

### 机制

dsh-base 里写着刻意的默认值：

```yaml
# Profile configuration reloads by default; module roots are opt-in.
- id: hmr
  config:
    root: []
```

`root: []` 意味着 HMR **不监视任何模块文件**，只监视配置。所以出厂状态下 profile 热重载的是配置，永远不是代码；而 Node 按 URL 缓存 ESM 模块，于是每次改宿主半边都要重启。在 **设置 → Plugins** 里禁用再启用插件**不是**重启的替代品——它只是在已加载的模块世代上重跑 `apply`。

opt-in 的做法是在 `cordis.patch.yml` 里覆盖 `hmr`（该文件头明确写着 "Edit cordis.patch.yml, not this file"）：

```yaml
- id: hmr
  config:
    base: file:///path/to/your/plugin-checkouts/
    root:
      - dsh-session-admin
      - another-plugin-you-are-developing
```

`base` 用**绝对 file:// URL** 而不是相对路径，因为这条 entry 声明在 dsh-base bundle 内部，其 `baseUrl` 不在你的 profile 里，相对路径会解析到别处。`root` 只列你实际在开发的插件检出目录，不要指向整个 workspace——同级的媒体素材、文档目录没有可加载模块，只会增加监视噪音。想回到出厂行为就删掉这条 entry。

### 一个容易误判的细节

**HMR 只对「它开始监视之后发生的变化」作出反应。** 第一次打开 `root` 时，磁盘上已经存在的文件状态不会被重新导入——它们没有变化事件。

开发时的实测：打开 `root` 之后，仅修改 `lib/index.js`（加一个可见标记），标记**出现**了，而同期早先改过的 `lib/report.js` / `lib/audit.js` 的改动**没有**生效——也就是 index.js 已重载、那两个仍是缓存模块。**让文件产生一次变化**（哪怕只是补一行注释）之后，两者都生效了。

一个更隐蔽的变体：如果先改了叶子模块、再改入口模块，重载会得到**混合世代**——新入口配旧依赖。对会移动文件的插件来说，这比完全不重载更危险。判断依据很简单：改了叶子模块却看不到行为变化，就假设运行中的代码与磁盘不一致，重启一次而不是继续调试。

所以打开 `root` 之后的第一次，或任何「改完发现没生效」的情况，先确认改的是不是变化事件之前就存在的状态。

### 验证方式

审计路径在 DSH 内部实测过（工具只被调用 `session_admin`，所有调用都是只读的，`gc` 除外的那次是故意缺少前置条件、被拒绝）：

| 调用 | 结果 |
| --- | --- |
| `{action:"report"}` | 成功。三个服务全部可用，报告包含标题、`live` 状态与级联数 |
| `{action:"attachments", deep:true}` | 成功。读完全部会话日志，给出保留/可回收的精确分类 |
| `{action:"attachments", gc:true, confirm:true}`（故意不给 `deep`） | 拒绝：`gc requires deep: true — refuse to collect on an unverified reference set` |
| `{action:"bogus-action"}` | 拒绝：`unknown action "bogus-action"; expected one of report, attachments` |

写路径在同一实例上做过完整往返：把一个会话移入回收站 → 日志与缓存都从 store 消失 → 还原 → **`sha256` 与操作前完全一致**。附件仓库在所有只读验证前后逐字节未变，证实全语料扫描与被拒的 `gc` 都没有写盘。

## 两条踩过的硬约束

这两条都不是风格问题，是「看起来对、跑起来静默错」的坑，各自有一条测试钉着。

### 1. 工具返回值必须是无损 JSON

宿主会拒绝无法无损往返 JSON 的工具结果，报错是 `tool "..." returned invalid output: value is not lossless JSON`——**整个结果被丢弃**，报告一个字都到不了模型。

致命之处在于触发条件：可选字段 `divergences.workspaceRegistryError` 只在注册表**健康**时才缺席，而 `JSON.stringify` 会静默丢掉 `undefined` 属性。也就是说，「一切正常」这条最常见路径恰好是坏的那条，而 CLI 直接打印文本时完全看不出来。所以 `runAudit` 的返回值统一过一遍 `losslessJson()`，`test/run-audit.test.mjs` 断言 `JSON.parse(JSON.stringify(value))` 与 `value` 深度相等。

### 2. 释放会话租约要用 `[Symbol.dispose]()`

`SessionObservation` 实现的是显式资源管理协议，disposer 是 `[Symbol.dispose]()`，**没有** `.dispose()` 方法。写 `observation.dispose?.()` 不会报错、不会抛异常，只是什么都不做——而查询服务的缓存很小且被钉住的条目永不被淘汰，一次泄漏就够把整份已解析语料钉在内存里。

`releaseObservation()` 先调符号，再回退到 `.dispose`，并返回是否真的释放了。测试里的假 observation **只**实现符号方法，因为一个只实现 `.dispose()` 的假对象会让真实的泄漏照样通过。

## 安全边界

写操作只有三处，且每处都有独立的前置条件：

| 写操作 | 前置条件 | 不可逆？ |
| --- | --- | --- |
| 归档 / 置顶 | 通过 `workspaceRegistry`，由宿主自己校验会话存在性 | 否 |
| 移入回收站 | 逐条复核 `live` 与日志存在；`sessionQuery` 不可用时**拒绝**而非猜测 | **否**（可还原） |
| 附件回收 | 必须 `deep` **且** `confirm`；删除前逐条重新校验路径包含性 | 是（但对象已无引用） |
| 清空回收站 | 必须 `confirm` | 是 |

其余保证：

- 未做引用计数扫描时**不产出候选清单**——「没查过」不允许被表述成「没引用」。
- 三个独立的保留理由分开计数，异常数字能追溯到具体规则：被会话引用 / 在 provider 文件索引里（无论是否过期）/ 在宽限期内。
- 服务不可用时对应列显示「未知」，不显示 0。
- 每一次写操作都在结果里写明实际改了几个、涉及多少字节，以及被跳过的条目和原因。

## 测试

```bash
npm test
```

68 个测试，全部是合成夹具，不依赖任何真实 DSH home：每条需要宿主服务的路径都注入假的 `sessionQuery` / `sessionPersistence` / `workspaceRegistry`，写路径则在临时目录里搭一个假的 DSH home 并真实移动文件。

重点覆盖那些「看起来对、跑起来会毁数据」的地方：无损 JSON 边界、租约释放、回收站的还原不覆盖、附件删除的路径包含性、以及未知值与零的区分。

### 在沙箱里跑测试

`node --test` 会为每个测试文件 spawn 子进程并捕获管道输出。如果测试运行在**禁止命名管道**的沙箱里（例如 DSH 的 `workspace-write` 文件策略），这一步会以 `EPERM` 失败。两种解法：

```bash
# Node 24+：进程内隔离，不 spawn 子进程
npm run test:in-process

# 或者在不受限的 shell 里跑
npm test
```

第二条在 Node 22 上是唯一可用的（`--test-isolation` 是 Node 24 的旗标）。

## 组成

```
dsh-session-admin/
├── package.json          # dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml      # 唯一一行：宿主半边
├── lib/
│   ├── index.js          # 插件入口：工具注册、参数校验、两条 HTTP 路由
│   ├── gather.js         # 唯一的读取路径（工具与面板共用）
│   ├── scan.js           # 文件系统侧扫描（只读）
│   ├── audit.js          # 与会话服务 join、级联标注、可回收性判定、租约释放
│   ├── state.js          # 面板消费的 wire 投影 + 删除许可判定
│   ├── actions.js        # 命令执行：归档/置顶/回收站/附件回收
│   ├── trash.js          # 回收站：同卷 rename、还原、清空
│   ├── report.js         # 文本报告渲染 + 无损 JSON 净化
│   └── client.js         # 客户端半边：中栏面板、侧边栏图标、设置页
├── test/                 # scan / audit / report / 参数 / 全路径 / 写路径 六组测试
└── tools/audit.mjs       # 不进 DSH 也能跑的同一份审计
```

零运行时依赖：只用 `ctx` 上的服务和 Node 内置模块（`node:fs` / `node:os` / `node:path`）。这是刻意的——插件通过 `link:` 装进 profile，从检出目录解析 DSH 内部包并不可靠，而 `ctx` 上的服务是稳定契约。

## 已知边界

- **报告是磁盘的瞬时快照，不感知 DSH 内部的写入队列。** 写操作前会复核 `live`，但两次复核之间的时间窗无法消除；对正在运行的会话做归档，请用 `stopActivity` 语义（面板会让带子会话或运行中的目标显式选择），而不是指望快照。
- **`workspace.json` 的归档集合没有 Service 暴露**，只能直接读文件。注册表损坏时报告 `ok: false` 并给出原因，不会当成「没有归档」。
- **`Workspace.sessionIds` 与文件里的 `sessionIds` 可能不一致**：前者被 canonical-cwd header 索引过滤过。这种差异会被单独列出，因为它正是「按工作区列表去删」会删错东西的场景。
- **回收站不会自动过期。** 移入回收站的会话会一直占着磁盘，直到你还原或清空它——这是刻意的，自动删除等于把不可逆操作藏起来。
- 附件引用扫描是 O(全部日志字节数)，冷读整个语料需要数秒到数十秒。
- 报告与面板文案目前只有中文。

## 许可证

MIT
