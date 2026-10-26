# DSH Forge

DSH Forge builds plugins for one fixed DSH Worker generation. The frontend requests plugin changes; Forge resolves registry dependencies, compiles each package separately and serves immutable artifacts. Core DSH and other host-provided packages are supplied by the frontend build and cannot be upgraded through Forge.

The initial service uses Node.js and TypeScript. Local files implement the artifact store that can later be replaced by COS. See [the design and protocol](docs/design.md) for the frontend installation lifecycle.

## Run locally

Use Node.js 24.9 or later and pnpm 11.28.5. Build the selected DeepSeek Harness checkout’s Worker runtime first; Forge imports its actual module transformer so suspension points retain the Worker's async-context semantics. The backend does not start DSH.

```sh
pnpm install
pnpm build
pnpm preview:prepare --dsh-root /absolute/path/to/deepseek-harness
pnpm start --target .data/preview/target.json --dsh-root /absolute/path/to/deepseek-harness \
  --origin http://localhost:36935 \
  --origin http://127.0.0.1:36935 \
  --origin http://100.76.198.140:36935
```

`pnpm preview:prepare --dsh-root PATH` copies the built static page, packs a credential-free Worker image and writes its exact package roster to `.data/preview/target.json`. Serve `.data/preview/site` with a static HTTP server. Add `?preview-fixture=none&forge=<encoded service URL>` to `/preview.html`, then open **DSH Forge**. Build the default example and execute `/forge-test`; changing `test v1` to `test v2` exercises hot replacement.

The Forge preview now enables browser-local IndexedDB persistence. Use the top toolbar’s explicit save action before reloading to drain buffered Session events and wait for browser storage. Automatic toolbar status covers filesystem writes that have already reached the VFS. Installed plugin artifacts, enabled/disabled selections, configuration, Session files and workspace changes reload before Cordis starts; installed plugins do not need Forge to be online during restoration. The base page and image still come from static hosting. `storage=none` opts into an ephemeral Worker without deleting saved data.

Storage uses individual file metadata and 64 KiB chunks, with incremental append writes. A catalog restores package mappings before profile loading. Schema, embedded generation, deployment path and image/overlay source isolate saved datasets; a different generation does not migrate existing data automatically. Stale-tab writes fail rather than overwriting a newer revision. Browser storage quota and site-data deletion still apply, and all live files remain in RAM. The replaceable provider interface supports a later native RPC adapter; this implementation does not synchronize cloud or Android data. Details live in the selected DSH runtime's `README.md` under Browser persistence.

`target.json` is operator-controlled and must describe the exact frontend image. Its format is:

```json
{
  "protocol": 1,
  "generation": "dsh-worker-1",
  "sharedPackages": ["@deepseek-ai/cordis"],
  "hostPackages": {
    "@deepseek-ai/cordis": "4.0.0"
  }
}
```

The version above is illustrative; generate the actual roster from the image. Changing compiler behavior requires a new generation and a corresponding frontend build. Requests cannot replace this configuration. `--transformer /absolute/path/to/module.js` can replace `--dsh-root`; the selected module must export `lowerModuleSource`.

The default listener is `http://127.0.0.1:36936`, with objects under `.data/artifacts/`. Use `--host`, `--port`, `--storage`, and repeated `--origin` flags to configure deployment. Origins must match the page's actual scheme, hostname and port. No browser origin is permitted unless explicitly configured. CLI/other non-browser requests without Origin remain allowed; CORS is not authentication. This development service has no user authentication and should remain loopback-bound unless a trusted authenticated ingress is provided.

`--registry` selects the npm registry, `--pnpm` its executable, `--install-timeout-ms` its deadline, `--max-request-bytes` the source upload bound, and `--max-builds` the concurrent build bound. Builds create fresh temporary workspaces and remove them on success or failure. Package installation scripts are disabled. Forge's own esbuild installation is approved in `pnpm-workspace.yaml`; that does not approve plugin installation scripts.

## Model-authored sources

Inside the configured DSH Worker shell, a model can write a source directory and invoke:

```sh
dsh plugin --profile web build ./greeting-source
```

The directory's `forge.json` supplies `id`, `name`, `version`, `entry` and an explicit `files` array, plus optional dependency and peer declarations. The Worker reads these files from its VFS and posts their contents to the existing `/v1/builds` endpoint; generation and protocol come from the running host. Filesystem reads and HTTP requests use the invocation's filesystem and configured HTTP provider. Forge returns the same immutable manifest as the page editor, and the Worker applies it through the same installer, HMR and durable catalog. Source text stays in the workspace; generated artifacts stay under the profile's Forge directory. Updating source requires another build command. No npm publication or local Node compiler is required. An optional `client` declaration builds a browser entry alongside the Host entry.

The command is part of the Worker compatibility CLI. Existing npm `add`, `update` and `remove` operations retain their behavior. Build or download failure preserves the installed plugin; activation failure reports failure without promising to recover the previous instance. An installed disabled plugin remains disabled. After verifying the result, use the page's explicit save action to drain Session buffers and commit browser storage.

### Client sources

A local source package can add an optional Client program to `forge.json`:

```json
{
  "id": "local-counter",
  "name": "local-counter",
  "version": "1.0.0",
  "entry": "index.ts",
  "files": ["index.ts", "client.tsx", "shared.ts"],
  "dependencies": {},
  "peerDependencies": {},
  "client": {
    "entry": "client.tsx",
    "files": ["client.tsx"],
    "inject": ["@deepseek-ai/dsh-client-ui-conversation"],
    "peerDependencies": { "react": "^18.3.1" }
  }
}
```

The root `files` list contains every submitted source. `client.entry` names a submitted JS, TS, JSX or TSX module. `client.files` declares files exclusively used by the Client and defaults to `[client.entry]`; it must include that entry, exclude the Host entry and be a subset of the root list. Every other submitted runtime file remains independently compiled for the Host, including helpers loaded through computed `require`/`import`. A shared helper therefore belongs in root `files` but outside `client.files`; the browser bundler also compiles it when the Client imports it. This explicit selection does not infer that a helper belongs only to the Client from static imports.

Client sources export an ordinary Cordis plugin, such as named `inject` and `apply`; they do not write `window.__ModuleLoader__` wrappers. Forge bundles the browser program into reserved `forge-client.js` and generates the supported `dsh.client` and `./client` metadata. The existing Client module graph loads and hot-replaces that artifact. Root `package.json`, arbitrary exports, custom display-resource declarations, CSS imports, non-JSON asset imports, code splitting and top-level await are unsupported. Styles can be lifecycle-owned JavaScript or React-rendered styles. Source files and the generated Client artifact use the existing VFS persistence and file hooks.

`client.inject` names package edges in the live Client graph, for example the conversation package that owns a slot; it does not name Cordis services such as `slots`. Injected packages must be present in the fixed target and actually mounted with a Client declaration. Target inventory membership alone cannot establish a live Client entry. A successful Host activation does not establish that the Client mounted or rendered; inspect the live slot and exercise the requested UI.

Optional `client.dependencies` and `client.peerDependencies` authorize browser imports in addition to the root declarations. Client-only ordinary dependencies are installed without scripts and bundled privately; they never add Worker Host package mappings. Root dependencies and peers keep their Host behavior. A name repeated between root and Client declarations must use the same range string; conflicting declarations fail before installation. Peers are not automatically installed. Each private dependency's own imports are checked against its manifest, including its shared peers and installed versions; dependency installation scripts remain unsupported.

The target's optional `clientModules` lists exact module-table requests, while `clientPackages` records their package-root versions. The preview generator obtains the request list from the same DSH build as the page. Browser imports reuse only exact supplied requests, including declared subpaths such as `react/jsx-runtime`; a package-root version does not authorize arbitrary subpaths. React, Cordis and DSH modules are never privately duplicated. An injected graph package may be imported by its package name or `/client` face when declared as a dependency or peer. Other core Client requests fail explicitly. Browser dependencies are resolved with browser conditions, and native Node modules are unavailable. Dynamic requests have only the already bundled code and registered page modules available; this build does not provide a separate runtime resolver for private Client packages.

## Optional host patch admission

Host requirements use their declared semver constraints by default. Operators can opt a named, already provided host package into exact stable patch admission with repeated `--allow-host-patch-upgrade PACKAGE` flags, or `CompilerOptions.allowHostPatchUpgrade`. For example, `--allow-host-patch-upgrade @deepseek-ai/cordis` lets an exact `4.0.1` requirement use the frontend’s existing `4.0.5`. It does not install or upgrade Cordis. The manifest still records the actual `4.0.5`, and the Worker still checks that exact version.

This policy accepts only equal or newer stable patches within the same major/minor for exact stable version strings. It does not relax downgrades, cross-minor/major versions, prereleases, or declared ranges and bounds. Each configured name must exist in the fixed target roster; other host packages remain strict. The option changes admission only, not emitted code or the frontend target, so it does not require a new build generation. Operators enable it only for packages whose patch compatibility they accept.

## Package compilation

1. Validate generation, source paths, semver dependency ranges and immutable host package requirements.
2. Install ordinary dependencies in an isolated pnpm workspace, without automatic peer installation or lifecycle scripts.
3. Preserve each runtime JS/TS/JSX/TSX/JSON file at its original package-relative path and extension. Source builds also keep their entry path; `.ts` files contain stripped JavaScript after compilation.
4. Independently strip syntax with esbuild and apply the same `lowerModuleSource` transform used by the DSH image packer; do not bundle relative modules.
5. Prepare every declared regular dependency and every available peer provider, including packages referenced only by computed requests.
6. Save content-addressed bytes and return a complete manifest. The frontend computes its own increment from file hashes.

Package identities incorporate name, version, entry path, compiled bytes, private dependency identities and the package’s explicit `hostDependencies` list. Independent builds of identical sources produce the same revision. Fixed shared modules and explicit target peers stay external and are listed with exact versions in manifest `hostPackages`. The target `hostPackages` inventory alone does not force sharing. Required target `sharedPackages` comes from the selected DSH build’s `forgeSharedPackages()` policy: DSH/Cordis packages, Client seed packages, and Worker static replacements retain their fixed identities. Ordinary dependencies use private installed instances even when the image has a compatible version; matching package contents and dependency identities still deduplicate. The target inventory contains no peer-binding metadata that could justify reusing an ordinary image package safely. An optional `clientPackages` target roster lists exact versions supplied by the static Client seed; missing rosters mean no Client packages. Client-only peers are recorded separately in manifest `clientPackages`, must satisfy their declared versions, and cannot be imported by Host code. A root plugin cannot replace any image or Client package; transitive ordinary packages may share a name with the image while remaining private. Fixed shared names cannot be remapped. Each package receives only its own `hostDependencies` and private mappings. Manifest `hostPackages` checks versions without granting every package access to the whole plan. Building does not execute plugin code and does not run a TypeScript type check; TS syntax is stripped. The Worker transformer converts ESM exports/imports and preserves raw CommonJS `module.exports`. Module requests, aliases, computed names, `require.resolve()` and dynamic imports execute through the Worker loader; no AST-based request whitelist attempts to recognize bundler wrappers. Runtime activation still belongs to DSH.

Peer requirements are validated separately from dependencies. A target peer must satisfy its declared range; an incompatible peer never triggers a private installation. When both fields name a package, both constraints must hold for the same provider. Missing non-target peers fail with `PEER_MISSING`; Forge only uses providers already present in the consumer installation tree and does not install peers automatically. An optional peer that is not also a required dependency may be absent; attempting to load an absent provider fails at runtime and can be caught by the plugin. If its provider is installed, its version still must satisfy the peer range. Supplied target peers remain version-checked and recorded, including optional Client peers used by the prebuilt bundle. A target peer inside a consumer context that supplies a private package of the same name fails with `PEER_CONTEXT_UNSUPPORTED`, rather than silently binding to the image. Full peer-context synthesis is outside this generation.

Prebuilt Client bundles keep their existing page module-table lookup. Host package dependency maps do not provide private Client externals. Client seed versions remain fixed; `dsh.client.external` declarations remain unsupported. A successful private Host dependency build does not establish that an equivalent page dependency is available.

This generation supports independent Host modules, relative and package subpath requests, computed loaders and package-local module cycles through the Worker cache. Package roots and preserved export trees use the Worker’s fixed active condition set (`browser`, `require`, `import`, `default`) in declaration order, rather than separate Node import/require faces. Dependency package cycles remain rejected because package identities include child identities. Installation scripts, native addon files, unsupported source syntax and unsupported package entry layouts remain explicit limits. Published Host compilation and source builds without a `client` declaration do not create browser bundles. Unknown or unavailable system modules and undeclared requests fail when resolved or called at runtime; successful compilation is not proof of activation. A failed build may leave immutable objects already produced for dependencies; no manifest is returned to activate them.

Every collected runtime file must be transformable, including published CLI scripts, examples and files not loaded during activation. The synchronous Worker module wrapper does not support top-level await. In the real `@xmanrui/dsh-im@5.6.0` build, alias-based requests pass compilation, but the published `bin/dsh-im.mjs` fails with `LOWERING_FAILED` because it contains top-level await. Forge does not replace that file with a successful stub or claim that the plugin can run.

The compiler and pnpm run in server processes, not a production isolation sandbox. The service needs additional workload isolation and resource enforcement before accepting untrusted public traffic.

## Published plugin builds

`POST /v1/packages/builds` accepts `{ "protocol": 1, "generation": "dsh-worker-1", "pluginId": "dsh-plugin", "spec": "dsh-plugin@2.2.1" }`. A spec is an npm name with an optional semver version/range; omission selects the registry version matching `*`. The published endpoint also accepts `@latest`, resolves that registry tag to an exact version before installation, and does not broaden source-build dependency constraints. Local paths, URLs, npm aliases and other dist-tags are rejected. The executor resolves the published Host entry and compiles it through the same pipeline as source builds.

Packages may include optional `metadata` with sanitized `dsh`, `exports`, and `repository` fields for the frontend-generated package.json. Forge validates the fields it consumes and strips unconsumed extensions at the `dsh`, `bundle`, and `client` levels, including advisory `compatibility` and `manifestVersion` declarations. Ignoring an advisory declaration does not establish runtime compatibility; fixed Host/Client versions and protected core packages remain checked. Known Client loading controls `external` and `immediately` are explicitly unsupported rather than stripped, because dropping them would change module loading behavior. `repository` is a string or an object containing only `url`. Supported bundle metadata declares one patch file containing exactly one insert row naming the package itself, plus optional literal overrides of other existing entries. The inserted entry accepts only `id`, `name`, and optional `config`. An override accepts only `id`, optional `config`, and optional `disabled` (boolean or null), with at least one of `config` or `disabled` present. Override IDs must be unique and cannot equal the inserted entry’s ID. Existing-entry lookup and plugin configuration validation belong to DSH when applying the patch; configuration may contain any JSON literal, including nested objects, arrays, scalars and null. Numbers must be finite and object keys must be strings. Standard JSON-compatible YAML tags are allowed; executable or other non-JSON tags, aliases, multiple inserted entries, other inserted package names, topology-changing overrides, and additional patch operations or entry fields (including `disabled` on the inserted entry) are rejected with the offending asset or field named. Plugin-specific configuration validation remains the plugin’s responsibility. The original patch bytes and the `./client` export's prebuilt Client bundle selected by browser/import/default conditions (including conditional exports with separate types) are retained as separate artifacts, subject to the explicit compatibility repair below. An omitted `dsh.client.inject` becomes an empty dependency list; platform and supplied list members remain validated. The Worker uses the unchanged manifest entry path as its generated root package.json main. Published `exports` preserves recursive conditions, arrays, null blocks and safe subpath patterns, including targets of unselected conditions that are absent from the artifact. Nested package.json files may be retained after their resolver paths are validated; the root package.json remains reserved for the installer. Type declaration files and unrelated root manifest fields are omitted. Unsupported bundle layouts fail explicitly. Publishing a prebuilt Client bundle does not imply that arbitrary TSX source can be compiled by this endpoint.

Published packages also retain ordinary non-module resources at their original relative paths, including Markdown skills, reference data and binary assets. This applies to packages without `dsh` metadata as well. Root package.json is synthesized by the Worker; dependency directories, type declarations, source maps and native addon files are excluded. Runtime modules are transformed independently; a declared prebuilt Client bundle remains unchanged apart from its explicit compatibility repair. Resource symlinks, nonregular files, package escapes and paths outside the Worker’s ASCII segment format fail explicitly. A root `index.js` Client asset is reserved for the public package wrapper. Resource files cannot replace the compiled entry or conflict with its parent/child paths.

`PnpmResolverOptions.maxResourceFiles` / `maxResourceBytes` and CLI `--max-resource-files` / `--max-resource-bytes` bound resources per package; defaults are 1,000 files and 32 MiB. Declared patches, Client bundles and all runtime modules count toward the same totals. Both collected source bytes and final transformed bytes must fit the budget. Each module retains its own `import.meta.url` directory, so deeper modules and the entry can resolve their relative resources. Resources are served as original bytes, without adding executors for other languages.

The configured DSH transformer only supplies code lowering. Node capability checks belong to the running Worker: supported namespaces resolve to its real implementations; optional operations can throw `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`; missing namespaces or unsupported mock operations fail when actually used. The compiler does not convert unavailable operations into successful stubs. Fixed generation, shared-package identities and declared peer versions remain validated before delivery.

`billion-context-dsh@0.2.27` declares a supported literal override that disables `compaction-basic` before inserting its own `compaction-acp` entry. Its published patch is retained unchanged. Compilation for the current DSH 0.2.1-rc.2 host still fails with `HOST_VERSION_MISMATCH`: the package requires `@deepseek-ai/dsh-brand@0.2.0-rc.2` and other older exact or bounded DSH peers. Supporting the patch structure does not relax those version requirements.

`dsh-context@0.76.0` reads `node:v8.getHeapStatistics()` to defer cold-session reads and projection backfill when used heap reaches two thirds of the heap limit. Its own error handler admits work when statistics are unavailable. With an optional `node:v8` namespace, the call throws `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` and this existing fallback runs; the Worker supplies no fabricated heap values. The work queue remains serialized, but its heap-pressure protection is unavailable. Successful compilation alone does not establish that every plugin feature works in the Worker.

`dsh-whale-widget@0.4.2` can import optional `node:dns`: its startup catches the unavailable `setDefaultResultOrder('ipv4first')` call. The browser does not apply that DNS preference. Its Host activates with all three required services available, `tapIndex` present, a structured script injection registered, and `/dsh-whale/widget.js` returning 200 through the Worker transport. The static page applies index injections at initial boot; installing this package afterward does not replay those rows or rerender the document through its HTML transform. No widget script element or widget UI appears. This package has no `dsh.client` entry for normal Client graph hot loading, so successful Host activation does not establish a usable widget.

`dsh-plugin@2.2.1` receives a version-scoped Client repair: its npm installation queue can expose a package-name mapping before the installed version is recorded. The published UI compares that missing version and crashes its settings slot. Forge defers this comparison until a nonempty version arrives; complete records retain the original comparison. After successful Worker installation or removal, Forge has already applied the Host and Client changes. The same repair removes Hub’s automatic page reload on completion-dialog close and background completion, and changes both languages’ success messages to report hot loading. Explicit restart and request-retry actions remain available. The repair checks the known comparison, reload paths and message counts; unexpected publication changes fail with `CLIENT_COMPATIBILITY_MISMATCH`. Other packages and versions are untouched. Repaired bytes receive their own content hash and revision.

`pnpm smoke:published` installs the actual `dsh-plugin@2.2.1` from npm through real HTTP, checks the Cordis patch-version admission, preserved patch bytes, the repaired Client artifact and sanitized metadata, and downloads all artifacts. The smoke reads the selected runtime’s generation and checkout’s Cordis version. It uses the explicit Cordis patch option because the publication declares 4.0.1 while the rc.2 host provides 4.0.5.

`@ljwei-stak/dsh-model-router@0.25.1` loads its Host command and Client workspace. Preserving its entry directory lets the Host version lookup read `../package.json`; Chrome acceptance reports the installed backend version 0.25.1. Actual model routing and native CLI operations are not covered by this acceptance test.

`whale-girl@0.1.0` compiles with separate `schemastery` and `cosmokit` artifacts, but activation fails because the current DSH jobs service does not provide its requested `onJobDone` method. Its independent Client can still mount partially. Its ordinary `function apply()` returns a disposer that the current Cordis constructor invocation does not collect; this also reproduces directly in Node. Removing the package therefore leaves its Client DOM behind until a page reload. Its `import.meta.dirname` requirement is also unsupported; ordinary resource retention does not supply that runtime API. This package is not usable on the current target; the acceptance test records the failure and residue explicitly rather than treating package installation as successful activation.

## Adapters

`src/index.ts` exports:

- `BuildExecutor`: consumes a validated request and returns a manifest.
- `PackageResolver`: prepares dependencies and resolves exact package entries.
- `ArtifactStore`: reads and writes immutable bytes by validated object key.
- `createForgeHandler`: Fetch Request/Response service with explicit CORS, upload bounds and concurrency admission.
- `startForgeServer`: Node HTTP listener returning `url`, `server`, and asynchronous `close()`.

The Fetch handler does not import Node HTTP or the compiler. An edge deployment can supply remote build execution and object storage adapters; the current pnpm/compiler implementation requires a Node process environment.

## Checks

```sh
pnpm check
pnpm test --dsh-root /absolute/path/to/deepseek-harness
pnpm smoke:npm --dsh-root /absolute/path/to/deepseek-harness
pnpm build
pnpm preview:prepare --dsh-root /absolute/path/to/deepseek-harness
pnpm test:browser --dsh-root /absolute/path/to/deepseek-harness --npm
pnpm test:plugin-hub --dsh-root /absolute/path/to/deepseek-harness
pnpm test:plugin-hub --dsh-root /absolute/path/to/deepseek-harness --preview-root .data/preview --persistence-only
pnpm test:plugin-hub --dsh-root /absolute/path/to/deepseek-harness --preview-root .data/preview --source-authoring-only
pnpm test:plugin-hub --dsh-root /absolute/path/to/deepseek-harness --preview-root .data/preview --client-source-only
```

`test:browser` uses installed Google Chrome and the selected DSH checkout’s Playwright dependency. It starts temporary HTTP services, verifies v1/v2 commands, no-op file counts, deletion, separate npm dependencies and preflight rejection in the same Worker, then compares `tests/expected/browser-lifecycle.json`. Test artifacts and screenshots remain under ignored `.data/`.

`test:plugin-hub --source-authoring-only` uses a private compatible model HTTP fixture through the real `session/prompt` Agent and tool pipeline. The fixture emits `write`, `bash` and `read` calls to build and update a multi-file TypeScript plugin with a private npm dependency, retains the active revision after a compiler failure, restores both code and source with Forge offline, and removes the plugin through a model tool call. It exports the Session log and checks that tool calls/results and the actual model-visible source-authoring guidance can be reconstructed. It never calls a paid model or changes the preview's default API credentials. Its owner-local snapshot is `tests/expected/source-authoring.json`.

`test:plugin-hub --client-source-only` adds an authored TSX component to the same real Agent workflow. It verifies `/test` increments an on-page counter over SSE, v1-to-v2 replacement preserves the Host value in the same page and Worker, a Client compile error keeps the active UI, and saved source, UI and count recover with Forge offline. Uninstall removes the component, style and Host route. The lane checks a 390-pixel viewport and records `tests/expected/client-source-authoring.json`; screenshots under `.data/forge-client-source-*` show the running component.

`test:plugin-hub --persistence-only` runs a separate Chrome cold-start lane with a private IndexedDB context. It holds the storage UI module request while the built shell starts, verifies that shell boot remains pending without a missing-loader error, and then releases the request to complete startup. It installs a published fixture, edits its configuration and workspace, names a session, waits for committed storage, and reloads with Forge requests blocked. Later reloads check disabled selection, updated artifacts and uninstall. A second source overlay verifies independent storage, competing tabs verify revision rejection, and an aborted transaction verifies visible failed saving. Corrupting this temporary namespace must prevent boot without replacing the stored bytes. Its owner-local snapshot is `tests/expected/persistence.json`; `.data/forge-storage-*.png` captures the actual saved, conflict, failed and mobile toolbar states. This lane starts fresh Workers; the existing hot-update lane explicitly uses `storage=none` and retains its one-Worker requirement.

`test:plugin-hub` first verifies HTTP request fields, progressive response streams and cancellation between a real dedicated Chrome Worker and a page-side provider. It then installs the published `dsh-plugin@2.2.1`, opens its settings UI, and installs through the actual catalog and confirmation buttons. It checks that closing the success dialog keeps the document and Worker alive, pending version records do not retire the settings slot, and the native switch starts enabled with one registration after an off/on cycle. It also exercises the HTTP task queue through virtual subprocesses. An isolated npm registry supplies a command-plugin fixture for add/update/remove and verifies the Worker’s `node:crypto.createHash` result. The actual `dsh-whale-widget@0.4.2` publication checks the distinction between admitting optional DNS imports and supporting its legacy widget UI; unavailable DNS operations still fail explicitly. Catalog and release metadata requests use the real remote services. It compares `tests/expected/plugin-hub.json` and requires network access.

Runtime-loading fixtures deliver a dependency referenced only through computed module names and preserve separate CommonJS, ESM, TypeScript and JSON files. A `typeof require` check and a generic `Proxy` wrapper exercise property forwarding and `require.apply(this, arguments)` without loader-variable special cases. Commands check that `require.resolve` does not evaluate modules, computed relative and package requests load on demand, repeated loads share the cache, and conditional and wildcard export subpaths select the expected files. A helper may use its declared host peer while the root plugin’s undeclared request for that same peer must fail, despite its presence in the plan-wide version inventory. Uncaught requests for undeclared packages or hidden subpaths must fail while existing commands remain usable. A version update and uninstall check single registration, file hooks and command cleanup in the same document and Worker.

Ordinary dependency isolation uses two local-registry plugins whose roots declare the real host `fast-deep-equal@3.1.3` as a peer, while a private wrapper imports test versions `90.0.1` and `90.0.2`. Each command executes both the real host equality function and its private module. Updating the first plugin to `90.0.3` must preserve the second module’s counter; removing both must preserve the host peer and the shared Cordis constructor. The test inspects host/private entries in the same manifest, checks file-hook notifications and single Loader registrations, and keeps the same document and Worker. The private registry retains upstream package versions and dist-tags and only adds the three exact test versions.

Separate local packages test optional DNS behavior: a caught `setDefaultResultOrder` refusal allows a command to run and report `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`; an uncaught call fails activation while existing commands remain usable. The TCP fixture compiles and imports `node:net`, but calling `net.connect()` fails activation with the Worker’s explicit unavailable-operation message; existing commands remain usable. The real whale widget test separately records Host activation, available services and script route, and the absence of its script element and UI in the already loaded static document.

The V8 fixtures likewise distinguish guarded fallback from an uncaught `getHeapStatistics` refusal, without manufacturing heap measurements. Published `dsh-context@0.76.0` activates, its real Host detail route reads a private test session, and its Client Context Insights dashboard opens. A fixed-version update keeps one Loader entry and the same stylesheet count; uninstall removes the dashboard entry, detail route and all observed plugin styles (`residualStyles: 0`). The test then reopens the marketplace in the same document and Worker. This verifies the detail/dashboard lifecycle without a model request; it does not exercise the plugin’s separate Client `/context` input command or every analytics feature.

A second local-registry bundle overrides the command fixture’s configuration, updates to disable that fixture while keeping its own command active, and restores the original nested configuration and commands when removed. The test checks Forge reports the intentionally disabled base as `disabled`, then `active` after removal, without changing a real chat or compaction plugin.

The same test installs `dsh-industry-research@0.3.23` with its published `lib/index.js` entry and packaged `skills/` directory, without a `skillsDir` override. A fixture command reads both skill bodies and the relative `references/frameworks.md` file through the public skill service and filesystem, lists all four registered tools, and checks the Remote skill catalog. Two fixed-version updates retain one Loader entry and the same skill and tool results; uninstall removes their registrations and resource files. The expected output records the skill-body hashes.

The same test installs published `dsh-web-mobile@3.2.0` and updates it to `3.2.1` without restarting the Worker or reloading the page. At a 390px viewport with a coarse pointer, it verifies the drawer opens, closes through Escape and the backdrop, and introduces no horizontal overflow. It checks Client replacement leaves one style sheet and one set of controls, deletes a newly created test session through the plugin's native Fetch route, and verifies uninstall removes styles, controls and the Host route. Chrome touch emulation does not constitute Android WebView validation; the plugin's Node HTTP response compression is not supported by the synthetic Worker response.

`pnpm test:plugin-hub --host=<reachable-local-IP> --chinese --default-id` exercises a non-localhost HTTP origin, Chinese at startup, and the preview form's default plugin ID. The test checks that the native plugin manager can resolve both installed bundles and that the marketplace survives repeated opening, settings navigation, and mobile-plugin installation while open. Published bundle installs select the package in the native profile bundle list; Forge and the native plugin switch share one Loader entry. Updates remove legacy Forge patch rows and preserve a user-disabled selection. Source plugins without bundle metadata continue to use Forge patch rows. An installed package can be disabled or fail activation; package availability alone does not establish that it is running.

Unit/integration tests use temporary directories and OS-assigned ports. They cover immutable storage and concurrent publication, real Worker lowering, dependency separation, shared host versions, invalid paths and imports, compilation failure cleanup, HTTP downloads/CORS/limits, and admission release after failures. `smoke:npm` explicitly uses the network to install `is-odd@3.0.1` and transitive `is-number@6.0.0`, verifies separate artifacts and executes the resulting dependency mapping locally. The tests expect the selected DSH runtime's `lib/index.js` to exist. `test`, `smoke:npm`, `smoke:published`, `preview:prepare`, `test:browser`, and `test:plugin-hub` require `--dsh-root PATH` or the `DSH_ROOT` environment variable; they never infer a sibling checkout. The CLI flag takes precedence over the environment variable.

## Isolated DSH baseline validation

Run baseline validation from a separate Forge worktree and pass the same absolute DSH worktree path to every command. `preview:prepare` replaces `.data/preview` in its own Forge worktree; changing only `--dsh-root` does not change that output directory. Do not run it from an existing deployment’s checkout. Build the selected DSH artifacts first, then run Forge checks, unit tests and npm smokes, prepare its preview, and run Chrome acceptance. Browser acceptance verifies the prepared target’s generation and both package rosters against its freshly packed image before starting services. Use separate listener ports and an explicit `--storage` directory when starting a persistent test server. `preview:prepare --out-dir PATH` and `test:plugin-hub --preview-root PATH` select an independent preview directory, so this validation does not replace an existing preview.

A baseline with different Worker/compiler behavior must use its own `FORGE_GENERATION`; an exact package roster alone cannot reject an older plan that imports no host packages. Generate the target from the new image rather than editing old version strings. The rc.2 source baseline provides Cordis 4.0.5, so the existing optional Cordis patch admission remains sufficient for Hub 2.2.1’s exact 4.0.1 declaration. DSH prerelease and Client requirements retain their declared semver checks; no baseline-wide version relaxation is applied. The base release’s lowerer exports are present, but Forge integration, the Client roster and required implemented Node modules must be ported and built before integration tests can pass.
