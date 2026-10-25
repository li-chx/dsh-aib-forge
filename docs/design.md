# DSH Forge：插件构建与热更新

本文件说明首版的职责、前后端协议、更新流程和验证范围。运行命令及不支持的包类型见 [README](../README.md)。

## 范围

Forge 是 DSH 专用的插件构建与分发服务。前端发起插件安装、更新和删除，维护已安装状态；后端负责依赖解析、编译及产物保存。DSH 核心及宿主共享模块由前端发布提供，不允许通过 Forge 更新。首版针对电脑 Chrome 中的 Worker Host 插件；TSX Client/UI 插件、通用 npm CLI、云端用户状态和实际 COS 接入不在首版范围。

静态前端内嵌构建代际 `dsh-worker-1`。同一代际使用固定编译配置；变更配置时发布新代际并重新构建产物。旧前端不能隐式切换代际。插件源码变更用产物内容哈希区分，不要求每次开发修改都提高 npm 版本。

## 分工

- Fetch HTTP handler：接受 Request，返回 Response，不直接依赖 Node HTTP listener。
- BuildExecutor：处理一个明确构建请求，返回不可变的插件清单；首版 Node 实现负责隔离临时目录和编译。
- PackageResolver：准备准确版本的 npm 依赖及其引用关系；首版使用后端 pnpm，关闭安装脚本。
- ArtifactStore：按不可变对象键读写字节；首版实现为本地文件系统，可替换为对象存储适配器。
- 前端安装器：校验代际、宿主依赖、清单和文件哈希，完整下载后在独占更新流程中写入 VFS、更新插件登记并请求 HMR。

边缘部署可复用 Fetch handler 和存储接口，构建执行仍需要支持相应工具链的执行环境；不宣称 Node/pnpm 构建器可以直接运行在任意边缘函数内。

## 协议 v1

所有 JSON 请求和响应带明确版本或代际。预期错误返回 `{ "error": { "code": "...", "message": "..." } }`，不得根据 message 字符串分派错误。

`GET /v1/target` 返回服务端目标 `{ protocol: 1, generation, sharedPackages, hostPackages, clientPackages? }`，其中 hostPackages 是宿主包名到准确版本的库存映射，不表示所有普通依赖都强制共享；必需的 sharedPackages 由所选 DSH 构建导出的 forgeSharedPackages() 生成，覆盖 DSH/Cordis、Client seed 和 Worker 静态替身；可选 clientPackages 是静态网页 seed 提供的 Client 包准确版本，缺省为空。服务端配置决定该映射，不能被请求覆盖。

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

## 已发布 npm 插件

`POST /v1/packages/builds` 接收 `{protocol:1,generation,pluginId,spec}`，例如 `spec: "dsh-plugin@2.2.1"`。spec 仅允许 npm 包名及可选 semver 版本范围，省略范围使用 `*`；额外支持 `@latest`，先查询 registry 标签对应的准确版本再安装，不放宽源码请求中的依赖范围校验。不接受文件路径、URL、别名或其他 dist-tag。后端在隔离目录解析已发布入口，通过同一 Host 编译流程生成清单。

`packages[].metadata` 保留编译器实际使用的包声明，未消费的附加元数据被剔除。支持的 bundle 包含恰好一个自身插件插入条目，并可通过其他根级行覆盖既有条目的字面量配置或启停状态；patch 原始字节由原生加载器合成。发布包的 Host 入口保留包内目录位置，普通资源按原相对路径分发，package.json 由前端合成。已构建的 Client 入口作为独立产物保留，此路径不编译 TSX 源码。字段、资源限额及支持子集见 [Published plugin builds](../README.md#published-plugin-builds)。

dsh-plugin@2.2.1 的 Client 有显式版本兼容修复：安装队列先写入仅含 npmPackage 的记录，版本同步完成前 UI 比较 undefined 会导致设置槽位崩溃。Forge 仅在该版本的已知函数及唯一比较语句匹配时添加版本存在检查，缺省版本暂不比较，完整记录沿用原逻辑。目标不匹配时返回 CLIENT_COMPATIBILITY_MISMATCH；成功安装、更新及卸载已完成 Worker 和 Client 热加载，因此移除这些成功路径的自动整页刷新，并调整中英文提示；保留主动重启后的刷新及失败重试。补丁逐个验证目标语句数量，其他包和版本不变，修改后的字节生成独立内容哈希及 revision。

Node 模块能力由运行中的 Worker 决定，后端只使用同一构建的 lowerModuleSource 转换代码，不维护静态模块引用准入表。缺失 namespace 或不支持的操作在实际 resolve/调用时失败，不用成功 stub 替代。可选 DNS、V8 操作仍抛平台不可用错误；插件可自行捕获降级。发布成功不等于所有功能可执行，固定共享包版本与代际保护不变。

## 前端应用与模块身份

前端使用 profile 下专属 `.forge` 目录保存插件产物与安装记录，不允许 Manifest 指定任意绝对写入路径。清单包被映射为各自的目录，模块加载器按引用方查找其 dependencies，再解析入口。宿主模块仍由原有加载器提供。禁止用插件包覆盖宿主包；同名不同版本的普通依赖可同时存在，内容和依赖环境相同的包可复用。

发布 bundle 通过 profile 的 dsh.profile.bundles 选择，由原生加载器使用其原始 entry id；无 bundle 的源码插件使用 Forge patch row。更新时在同一次串行重组中移除旧 Forge row，避免与原生启用开关重复登记；原生已禁用的插件更新后保持禁用。更新保持稳定插件 id 和入口包装文件路径，包装文件引用当前不可变包产物。替换包装文件内容后，由现有 HMR 文件比较发现变化并替换插件定义。删除首先卸载登记，再回收无引用的产物。用户已有 profile patch 必须保留。更新在同一串行流程内应用，文件到齐前不触发重载。下载/校验失败保持原状态；运行时激活失败必须返回失败/待恢复状态，不保证恢复旧实例。

## 文件变更与持久化

所有安装文件、删除和安装记录写入均通过运行时 VFS mutation API，不可绕过 write hook 或使用静默 image seed。复用 `Vfs.subscribe` 和 `VfsMutationSink` 的写入后通知。更新管理器提供批次开始、文件应用完成、激活结果信息，关联插件 id 和 revision；这些事件便于未来持久化，不代表存储已完成。

内存写入成功、插件激活成功、持久化成功分别表示。观察者失败不能被误报为持久化成功；本轮不实现跨刷新持久化。核心保护在计划校验及实际应用入口执行，不能只依赖 HMR 的启动模块保护。

## 验证

- 后端本地启动，真实 HTTP 构建 TS 插件，依赖独立产出并能下载。
- Chrome 中新增命令、v1 到 v2 热替换、删除命令，同一页面和 Worker 保持运行。
- 文件 mutation hook 观察到安装/更新/删除；无变化文件不重复下载/写入。
- 错误代际、核心覆盖、路径穿越、哈希错误和编译失败不修改当前安装。
- 构建、存储及浏览器测试使用独立临时目录和动态端口，关闭服务和浏览器后无泄漏。

2026-10-25 的真实 Chrome 验证通过：默认 TS 命令插件安装、v1 → v2 热替换、重复安装 0 下载/0 写入、删除，以及 `is-odd → is-number` 独立依赖运行。期间页面未刷新，Worker 启动次数为 1。错误代际、核心覆盖及损坏产物被拒绝，原 v2 命令仍可运行。行为快照位于 `tests/expected/browser-lifecycle.json`；截图位于忽略的 `.data/`。

Worker 路由使用现有页面隧道：`GET /__forge/target` 和 `GET /__forge/installed` 读取目标与状态，`POST /__forge/install` 接收 `{manifest, baseUrl}`，`POST /__forge/remove` 接收 `{pluginId}`。正常应用响应区分 `active`、`disabled`、`removed`、`activation-failed`，并返回下载/写入计数和观察者错误。预检错误返回非 2xx；激活失败通过结果字段报告。

Forge 保留每个模块的原始路径和扩展，独立剥除 TS/JSX 语法并经 Worker lowerer 转换。CommonJS 保留 module.exports 原值；计算模块请求在运行时执行。声明文件、map、native addon 和 node_modules 不复制；资源预算同时约束源字节和最终转换产物。
