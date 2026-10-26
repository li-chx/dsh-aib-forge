# DSH Forge：插件构建与热更新

本文件说明服务职责、前后端协议、更新流程和验证范围。运行命令及不支持的包类型见 [README](../README.md)。

## 范围

Forge 是 DSH 专用的插件构建与分发服务。前端发起插件安装、更新和删除，维护已安装状态；后端负责依赖解析、编译及产物保存。DSH 核心及宿主共享模块由前端发布提供，不允许通过 Forge 更新。实现面向电脑 Chrome 中的 Worker Host 插件，以及通过源码构建生成的 JS/TS/TSX Client 插件；通用 npm CLI、云端用户状态和实际 COS 接入不在范围内。

静态前端内嵌所选运行时的 `FORGE_GENERATION`；`preview:prepare` 从同一构建生成服务端目标。同一代际使用固定编译配置；变更配置时发布新代际并重新构建产物。旧前端不能隐式切换代际。插件源码变更用产物内容哈希区分，不要求每次开发修改都提高 npm 版本。

## 分工

- Fetch HTTP handler：接受 Request，返回 Response，不直接依赖 Node HTTP listener。
- BuildExecutor：处理一个明确构建请求，返回不可变的插件清单；首版 Node 实现负责隔离临时目录和编译。
- PackageResolver：准备准确版本的 npm 依赖及其引用关系；首版使用后端 pnpm，关闭安装脚本。
- ArtifactStore：按不可变对象键读写字节；首版实现为本地文件系统，可替换为对象存储适配器。
- 前端安装器：校验代际、宿主依赖、清单和文件哈希，完整下载后在独占更新流程中写入 VFS、更新插件登记并请求 HMR。

dsh-aiw 页面通过 Worker 本地的 `/__aiw/status` 与 `/__aiw/action` 管理文件、源码项目、历史版本及归档；编译请求再经配置的 HTTP 提供者发送到 Forge `/v1/` 接口。文件和用户状态由浏览器 VFS 及其持久化提供者负责，Forge 的产物存储不承担用户 profile 或会话备份。

边缘部署可复用 Fetch handler 和存储接口，构建执行仍需要支持相应工具链的执行环境；不宣称 Node/pnpm 构建器可以直接运行在任意边缘函数内。

## 协议 v1

构建请求、目标信息及产物清单带明确协议版本和构建代际。预期错误返回 `{ "error": { "code": "...", "message": "..." } }`，不得根据 message 字符串分派错误。

`GET /v1/target` 返回服务端目标 `{ protocol: 1, generation, sharedPackages, hostPackages, clientPackages?, clientModules? }`，其中 hostPackages 是宿主包名到准确版本的库存映射，不表示所有普通依赖都强制共享；必需的 sharedPackages 由所选 DSH 构建导出的 forgeSharedPackages() 生成，覆盖 DSH/Cordis、Client seed 和 Worker 静态替身；可选 clientPackages 是静态网页 seed 提供的 Client 包准确版本，缺省为空。可选 clientModules 是同一前端构建提供的准确模块请求列表，例如 react 与 react/jsx-runtime；包根版本不表示任意子路径都可用。服务端配置决定该映射，不能被请求覆盖。

`POST /v1/builds` 接受：

```json
{
  "protocol": 1,
  "generation": "dsh-worker-1",
  "plugin": {
    "id": "greeting",
    "name": "local-greeting",
    "version": "0.0.1",
    "entry": "src/index.ts",
    "files": { "src/index.ts": "export function apply(ctx) { /* ... */ }" },
    "dependencies": {},
    "peerDependencies": {}
  }
}
```

响应为完整 Manifest，而非针对某个客户端历史计算的差分。前端比较哈希，只下载本地缺失文件。一次完整解析和编译失败不会产生可安装的 Manifest。

```json
{
  "protocol": 1,
  "generation": "dsh-worker-1",
  "revision": "<sha256>",
  "plugin": { "id": "greeting", "name": "local-greeting", "version": "0.0.1", "packageId": "<package-id>", "entry": "src/index.ts" },
  "hostPackages": {},
  "packages": [
    {
      "id": "<package-id>",
      "name": "local-greeting",
      "version": "0.0.1",
      "entry": "src/index.ts",
      "dependencies": {},
      "hostDependencies": [],
      "files": [{ "path": "src/index.ts", "sha256": "<sha256>", "size": 100, "objectKey": "dsh-worker-1/objects/<sha256>" }]
    }
  ]
}
```

`packages[].dependencies` 将引用的包名映射到此清单中的 package id。宿主包引用必须出现在本包的 hostDependencies 数组及 Manifest.hostPackages 中，后者记录准确版本。全局版本集合不向每个包授予所有宿主依赖；本包 hostDependencies 和 entry 一起纳入包身份。仅由 Client 提供的 peer 依赖单独记入 Manifest.clientPackages，按声明版本验证，不能由 Host 代码 import/require；根插件不能替换两个名册中的同名包；固定共享包不允许重映射。普通 dependencies 始终按隔离安装树解析私有实例，即使宿主版本满足范围也不复用，因为库存没有该宿主实例的 peer 绑定信息。同内容、同依赖身份仍可复用产物。运行时模块逐文件转换，不内联包内相对模块或外部依赖。所有声明的普通依赖与可提供的 peer 都预先准备，包括只有计算 require/import 才会使用的包。require 别名、动态参数、resolve、子路径和 import() 交给 Worker 执行；编译阶段不再用 AST 白名单识别包装器。包内模块循环由模块缓存处理，跨包依赖循环因内容身份递归仍明确拒绝。exports 保留安全递归条件、数组、null 和子路径通配，Worker 使用 browser/require/import/default 固定条件集合按声明顺序选择，不提供 Node 的 import/require 双条件分离。

peerDependencies 与 dependencies 分别验证，同名声明必须同时满足同一供应实例。target peer 必须符合宿主或页面提供的准确版本，不通过自动安装副本消除冲突。非 target peer 只使用消费者安装树中已经存在的供应者，缺失报 PEER_MISSING；没有同名必需 dependency 的 optional peer 可以缺失，实际加载失败由运行时代码捕获；安装树已提供的 optional peer 仍须满足声明范围。target 已提供的 optional peer 仍校验版本并记入清单，包括预构建 Client 使用的页面依赖。消费者已提供同名私有依赖时，下游不能偷偷将该 peer 改绑宿主，当前明确报 PEER_CONTEXT_UNSUPPORTED，不实现完整 peer 上下文合成。Client 预构建产物仍使用页面全局模块表，Worker 的包级私有映射不等于 Client 外部依赖映射；固定 seed 校验及 client.external 不支持规则保持不变。

`GET /v1/artifacts/<objectKey>` 返回字节。objectKey 必须来自清单，严格验证路径和哈希。后端不得读取或发布请求指定的任意本机文件。服务端默认回环监听；允许的前端 Origin 由配置明确指定。

## 可选宿主补丁版本准入

默认按插件声明的 semver 条件校验宿主包。服务端可通过重复的 `--allow-host-patch-upgrade PACKAGE` 为固定宿主清单中的指定包启用补丁版本准入：精确稳定版本 `4.0.1` 可以使用同一 major/minor 下已经存在的 `4.0.5`。只允许相等或较新的稳定 patch，不放宽降级、跨 minor/major、预发布版本或任何声明的版本范围及上界。未列入策略的包保持严格校验。

该选项表示部署者接受指定宿主包的补丁兼容性，不安装或升级核心。Manifest 仍写入实际宿主版本，前端仍逐项精确匹配。它只改变后端请求准入，不改变转换器、产物生成方式或前端宿主版本，因此不要求更换构建代际。

## 模型源码构建入口

Worker 兼容 CLI 提供 `dsh plugin --profile <profile> build <directory>`。目录相对于调用方 shell 的 cwd 解析，`forge.json` 明确列出插件身份、入口、文件和依赖。命令从调用方的异步文件系统读取选定源码，不递归搜集工作区；协议和代际取自宿主。所有源码读取完成后，通过已注入的 HTTP 提供者调用同一个 `/v1/builds`，随后复用安装器的校验、文件 hook、HMR 与持久化清单。异步读取期间修改 Forge 地址不会改变已发起命令选定的服务器。

源码校验、下载和编译失败不替换当前插件；激活失败沿既有安装结果报告，不承诺恢复旧实例。更新保持 id 与包名，修改源文件后须再次执行构建，禁用状态保留。该入口可同时编译 Host 源码和显式声明的 Client 程序，不提供通用 Node 执行能力。环境提示词通过既有 system-prompt 记录流程告诉模型命令、持久化确认和可用能力，真实工具调用仍经过 Agent 策略与 Session 日志。

### Client 源码程序

源码请求可加入 `client: { entry, files?, inject?, dependencies?, peerDependencies? }`。根 files 显式提交全部源码；client.entry 必须是其中的 JS/TS/JSX/TSX 文件。client.files 默认为仅含 Client 入口的列表，表示完全不属于 Host 程序的文件；列表必须含 Client 入口，不得含 Host 入口，并须是根 files 的子集。其他文件继续逐文件转换为 Host 模块，因此 Host 的计算 require/import 不会因为 Client 也引用某个 helper 就丢失文件。共享 helper 不放入 client.files，浏览器打包器按 Client 导入再次编译它。

Client 源码使用普通 Cordis 插件导出，Forge 通过 esbuild 浏览器配置生成一个 lazy factory，保存为保留路径 forge-client.js，并生成 dsh.client 与 ./client 导出。原有 Client 图、槽位、HMR 和产物持久化负责后续加载。client.inject 是实际挂载的 Client 包依赖边，不是 slots 等 service 名；仅出现在 Host target 库存不能证明该包有运行中的 Client 半。必须验证 Client 挂载和页面行为，不能从 Host 构建或激活成功推断 UI 已生效。

client.dependencies 中的私有浏览器依赖只打包进 Client 产物，不授予 Host 私有映射；client.peerDependencies 不自动安装。Client 导入可使用两组声明及根声明，同名跨面声明在本代际必须使用相同范围字符串。每个私有依赖自己的引用也按其 manifest 检查，并验证供应版本和安装脚本策略。准确 clientModules 请求复用页面 seed；带 inject 的 Client 图包可通过包名或 /client 请求，其他 DSH/Cordis 请求不允许打包副本。浏览器解析使用 browser 条件，不提供原生 Node 模块，也不提供私有 Client 包的动态运行时解析器。

该入口不接受自带根 package.json、自定义显示资源导出、CSS 或非 JSON 资源 import、代码拆分或顶层 await。样式可由 JavaScript 的生命周期 effect 或 React 样式元素管理。输入和产物受资源总量限制，构建不执行插件代码，也不做 TypeScript 类型检查。完整 forge.json 示例见 [Client sources](../README.md#client-sources)。

## 已发布 npm 插件

`POST /v1/packages/builds` 接收 `{protocol:1,generation,pluginId,spec}`，例如 `spec: "dsh-plugin@2.2.1"`。spec 仅允许 npm 包名及可选 semver 版本范围，省略范围使用 `*`；额外支持 `@latest`，先查询 registry 标签对应的准确版本再安装，不放宽源码请求中的依赖范围校验。不接受文件路径、URL、别名或其他 dist-tag。后端在隔离目录解析已发布入口，通过同一 Host 编译流程生成清单。

`packages[].metadata` 保留编译器实际使用的包声明，未消费的附加元数据被剔除。支持的 bundle 包含恰好一个自身插件插入条目，并可通过其他根级行覆盖既有条目的字面量配置或启停状态；patch 原始字节由原生加载器合成。发布包的 Host 入口保留包内目录位置，普通资源按原相对路径分发，package.json 由前端合成。已构建的 Client 入口作为独立产物保留，此路径不编译 TSX 源码。字段、资源限额及支持子集见 [Published plugin builds](../README.md#published-plugin-builds)。

dsh-plugin@2.2.1 的 Client 有显式版本兼容修复：安装队列先写入仅含 npmPackage 的记录，版本同步完成前 UI 比较 undefined 会导致设置槽位崩溃。Forge 仅在该版本的已知函数及唯一比较语句匹配时添加版本存在检查，缺省版本暂不比较，完整记录沿用原逻辑。目标不匹配时返回 CLIENT_COMPATIBILITY_MISMATCH；成功安装、更新及卸载已完成 Worker 和 Client 热加载，因此移除这些成功路径的自动整页刷新，并调整中英文提示；保留主动重启后的刷新及失败重试。补丁逐个验证目标语句数量，其他包和版本不变，修改后的字节生成独立内容哈希及 revision。

Node 模块能力由运行中的 Worker 决定，后端只使用同一构建的 lowerModuleSource 转换代码，不维护静态模块引用准入表。缺失 namespace 或不支持的操作在实际 resolve/调用时失败，不用成功 stub 替代。可选 DNS、V8 操作仍抛平台不可用错误；插件可自行捕获降级。发布成功不等于所有功能可执行，固定共享包版本与代际保护不变。

## 前端应用与模块身份

前端使用 profile 下专属 `.forge` 目录保存插件产物与安装记录，不允许 Manifest 指定任意绝对写入路径。清单包被映射为各自的目录，模块加载器按引用方查找其 dependencies，再解析入口。宿主模块仍由原有加载器提供。禁止用插件包覆盖宿主包；同名不同版本的普通依赖可同时存在，内容和依赖环境相同的包可复用。

发布 bundle 通过 profile 的 dsh.profile.bundles 选择，由原生加载器使用其原始 entry id；无 bundle 的源码插件使用 Forge patch row。更新时在同一次串行重组中移除旧 Forge row，避免与原生启用开关重复登记；原生已禁用的插件更新后保持禁用。更新保持稳定插件 id 和入口包装文件路径，包装文件引用当前不可变包产物。替换包装文件内容后，由现有 HMR 文件比较发现变化并替换插件定义。删除首先卸载登记，再回收无引用的产物。用户已有 profile patch 必须保留。更新在同一串行流程内应用，文件到齐前不触发重载。下载/校验失败保持原状态；运行时激活失败必须返回失败/待恢复状态，不保证恢复旧实例。

## 文件变更与持久化

所有安装文件、删除和安装记录写入均通过运行时 VFS mutation API，不可绕过 write hook 或使用静默 image seed。`VfsPersistenceController` 订阅写入后通知，将 `home/` 和 `workspace/` 的变化提交给可替换的 `VfsPersistenceProvider`；当前实现是 IndexedDB，后续 RPC 提供者可以沿用同一接口。基础镜像的未修改文件不复制到存储。文件元数据、删除标记和 64 KiB 分块分别保存，追加写入只提交增量。

Forge 在 Profile 的 `.forge/installed.json` 记录已应用清单及保留产物。安装前段将文件、Profile 选择和清单组成同步批次，在等待 Cordis 前纳入同一个原子存储批次；卸载完成后，文件回收与清单删除组成同步批次。启动时先恢复 VFS，再校验清单与产物哈希并重建模块映射，最后启动原生 Profile/Loader。启停状态由持久化的 Profile 决定，激活结果不作为可直接复用的内存状态保存。已安装插件的冷加载不要求 Forge 在线；静态页面和基础镜像仍须可访问。

存储命名空间包含 schema、内嵌构建代际、部署路径和镜像/overlay 来源。切换代际选择独立数据，不隐式迁移或跨版本加载插件。每次提交原子比较 revision，陈旧标签页报 `STORAGE_CONFLICT` 并停止写回。存储失败保留内存变化并持续显示未保存；坏快照或清单阻止启动且保留原数据，不自动覆盖。直接修改不可变包产物也会因哈希不匹配阻止恢复。

内存写入成功、插件激活成功、持久化成功分别表示。页面顶部工具栏显示文件系统的待保存、已保存或失败状态。显式保存先调用已挂载的 Session 持久化服务排空事件缓冲，再等待 VFS 存储事务；任一步失败均不确认成功。自动文件系统状态不覆盖仍未进入 VFS 的 Session 事件，不依赖页面卸载回调。当前不保存执行中的请求、插件内存或临时 DOM，不实现跨标签页合并、云同步和原生 RPC。恢复后的文件仍驻留 RAM。浏览器配额、数据清理与存储回收由浏览器控制。

## 验证

- 后端本地启动，真实 HTTP 构建 TS 插件，依赖独立产出并能下载。
- Chrome 中新增命令、v1 到 v2 热替换、删除命令，同一页面和 Worker 保持运行。
- 文件 mutation hook 观察到安装/更新/删除；无变化文件不重复下载/写入。
- 错误代际、核心覆盖、路径穿越、哈希错误和编译失败不修改当前安装。
- 构建、存储及浏览器测试使用独立临时目录和动态端口，关闭服务和浏览器后无泄漏。

2026-10-25 的真实 Chrome 验证通过：默认 TS 命令插件安装、v1 → v2 热替换、重复安装 0 下载/0 写入、删除，以及 `is-odd → is-number` 独立依赖运行。期间页面未刷新，Worker 启动次数为 1。错误代际、核心覆盖及损坏产物被拒绝，原 v2 命令仍可运行。行为快照位于 `tests/expected/browser-lifecycle.json`；截图位于忽略的 `.data/`。

Worker 路由使用现有页面隧道：`GET /__forge/target` 和 `GET /__forge/installed` 读取目标与状态，`POST /__forge/install` 接收 `{manifest, baseUrl}`，`POST /__forge/remove` 接收 `{pluginId}`。正常应用响应区分 `active`、`disabled`、`removed`、`activation-failed`，并返回下载/写入计数和观察者错误。预检错误返回非 2xx；激活失败通过结果字段报告。

Forge 保留每个模块的原始路径和扩展，独立剥除 TS/JSX 语法并经 Worker lowerer 转换。CommonJS 保留 module.exports 原值；计算模块请求在运行时执行。声明文件、map、native addon 和 node_modules 不复制；资源预算同时约束源字节和最终转换产物。
