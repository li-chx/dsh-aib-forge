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

`target.json` is operator-controlled and must describe the exact frontend image. Its format is:

```json
{
  "protocol": 1,
  "generation": "dsh-worker-1",
  "hostPackages": {
    "@deepseek-ai/cordis": "4.0.0"
  }
}
```

The version above is illustrative; generate the actual roster from the image. Changing compiler behavior requires a new generation and a corresponding frontend build. Requests cannot replace this configuration. `--transformer /absolute/path/to/module.js` can replace `--dsh-root`; the selected module must export `lowerModuleSource`.

The default listener is `http://127.0.0.1:36936`, with objects under `.data/artifacts/`. Use `--host`, `--port`, `--storage`, and repeated `--origin` flags to configure deployment. Origins must match the page's actual scheme, hostname and port. No browser origin is permitted unless explicitly configured. CLI/other non-browser requests without Origin remain allowed; CORS is not authentication. This development service has no user authentication and should remain loopback-bound unless a trusted authenticated ingress is provided.

`--registry` selects the npm registry, `--pnpm` its executable, `--install-timeout-ms` its deadline, `--max-request-bytes` the source upload bound, and `--max-builds` the concurrent build bound. Builds create fresh temporary workspaces and remove them on success or failure. Package installation scripts are disabled. Forge's own esbuild installation is approved in `pnpm-workspace.yaml`; that does not approve plugin installation scripts.

## Optional host patch admission

Host requirements use their declared semver constraints by default. Operators can opt a named, already provided host package into exact stable patch admission with repeated `--allow-host-patch-upgrade PACKAGE` flags, or `CompilerOptions.allowHostPatchUpgrade`. For example, `--allow-host-patch-upgrade @deepseek-ai/cordis` lets an exact `4.0.1` requirement use the frontend’s existing `4.0.5`. It does not install or upgrade Cordis. The manifest still records the actual `4.0.5`, and the Worker still checks that exact version.

This policy accepts only equal or newer stable patches within the same major/minor for exact stable version strings. It does not relax downgrades, cross-minor/major versions, prereleases, or declared ranges and bounds. Each configured name must exist in the fixed target roster; other host packages remain strict. The option changes admission only, not emitted code or the frontend target, so it does not require a new build generation. Operators enable it only for packages whose patch compatibility they accept.

## Package compilation

1. Validate generation, source paths, semver dependency ranges and immutable host package requirements.
2. Install non-host dependencies in an isolated pnpm workspace, without automatic peer installation or lifecycle scripts.
3. Bundle modules inside each package into `index.js`; preserve bare cross-package imports as `require()` requests.
4. Apply the same `lowerModuleSource` transform used by the DSH image packer.
5. Resolve imported dependencies to exact installed package instances and independently compile them.
6. Save content-addressed bytes and return a complete manifest. The frontend computes its own increment from file hashes.

Package identities incorporate name, version, compiled bytes and dependency identities. Independent builds of identical sources produce the same revision. Host modules stay external and are listed with exact versions in `hostPackages`. An optional `clientPackages` target roster lists exact versions supplied by the static Client seed; missing rosters mean no Client packages. Client-only peers are recorded separately in manifest `clientPackages`, must satisfy their declared versions, and cannot be imported by Host code. Both rosters are protected from plugin replacement. Other imports use the package-specific dependency map. Building does not execute plugin code and does not run a TypeScript type check; TS syntax is stripped and module compatibility is checked. Bundling preserves external ESM imports for the Worker transformer, which selects defaults from ESM namespaces or raw CommonJS exports. CommonJS entry results retain their raw `module.exports` value; source imports and requires are checked before bundling. Runtime activation still belongs to DSH.

This generation supports JS/TS Host plugin entrypoints, package-local JS/TS/JSON imports, npm semver ranges and root imports of compatible registry packages. It explicitly rejects unsupported system modules, bare subpath imports, computed imports, loader aliases, dependency cycles, install-script packages, CommonJS consumers whose require/main entry differs from the shared import entry, and unsupported package entry layouts. Package roots select browser/import exports, or legacy browser/module/main in that order; every accepted importer shares that selected package instance. Compiling TSX UI source, arbitrary npm tooling, build scripts, native addons, browser remapping objects without an exports entry, and automatic browser shims are outside this version. Unsupported requests return stable error codes, not partially installable manifests. A failed build may leave immutable objects already produced for dependencies; no manifest is returned to activate them.

The compiler and pnpm run in server processes, not a production isolation sandbox. The service needs additional workload isolation and resource enforcement before accepting untrusted public traffic.

## Published plugin builds

`POST /v1/packages/builds` accepts `{ "protocol": 1, "generation": "dsh-worker-1", "pluginId": "dsh-plugin", "spec": "dsh-plugin@2.2.1" }`. A spec is an npm name with an optional semver version/range; omission selects the registry version matching `*`. The published endpoint also accepts `@latest`, resolves that registry tag to an exact version before installation, and does not broaden source-build dependency constraints. Local paths, URLs, npm aliases and other dist-tags are rejected. The executor resolves the published Host entry and compiles it through the same pipeline as source builds.

Packages may include optional `metadata` with sanitized `dsh`, `exports`, and `repository` fields for the frontend-generated package.json. Forge validates the fields it consumes and strips unconsumed extensions at the `dsh`, `bundle`, and `client` levels, including advisory `compatibility` and `manifestVersion` declarations. Ignoring an advisory declaration does not establish runtime compatibility; fixed Host/Client versions and protected core packages remain checked. Known Client loading controls `external` and `immediately` are explicitly unsupported rather than stripped, because dropping them would change module loading behavior. `repository` is a string or an object containing only `url`. Supported bundle metadata declares one patch file whose content is a single insert row naming the package itself. Its entry accepts only `id`, `name`, and optional `config`; configuration may contain any JSON literal, including nested objects, arrays, scalars and null. Numbers must be finite and object keys must be strings. Standard JSON-compatible YAML tags are allowed; executable or other non-JSON tags, aliases, multiple entries, other package names, and additional patch operations or entry fields (including `disabled`) are rejected with the offending asset or field named. Plugin-specific configuration validation remains the plugin’s responsibility. The original patch bytes and the `./client` export's prebuilt Client bundle selected by browser/import/default conditions (including conditional exports with separate types) are retained as separate artifacts, subject to the explicit compatibility repair below. An omitted `dsh.client.inject` becomes an empty dependency list; platform and supplied list members remain validated. The Host export is rewritten to `./index.js`; types and unrelated package.json fields are omitted. Forge never returns a package.json artifact. Unsupported bundle layouts fail explicitly. Publishing a prebuilt Client bundle does not imply that arbitrary TSX source can be compiled by this endpoint.

The compiler derives available Node module names from the selected DSH transformer module’s `MODULE_PROXIES`: only `node:` entries classified under `builtin_modules/implemented/` may remain external. Equivalent bare names are normalized to those entries. Structural mocks and missing modules remain rejected. This includes the existing `node:crypto` hash/random implementation without adding a new shim or maintaining a second hardcoded list. The Worker owns each module’s supported operations; an implemented module does not imply complete Node API compatibility. The selected DSH module is operator configuration and must match the fixed frontend generation. This admission change does not loosen generation or host-package version checks, or alter the target protocol.

`dsh-whale-widget@0.4.2` is currently unsupported: its `node:dns` import is rejected before activation. Its UI also relies on `tapIndex` and startup script injection rather than a `dsh.client` bundle, and uses package image/audio assets. Those legacy injection and asset paths are not provided by Forge; accepting `node:crypto` alone cannot make this package usable. This compilation failure leaves the existing plugins active.

`dsh-plugin@2.2.1` receives a version-scoped Client repair: its npm installation queue can expose a package-name mapping before the installed version is recorded. The published UI compares that missing version and crashes its settings slot. Forge defers this comparison until a nonempty version arrives; complete records retain the original comparison. After successful Worker installation or removal, Forge has already applied the Host and Client changes. The same repair removes Hub’s automatic page reload on completion-dialog close and background completion, and changes both languages’ success messages to report hot loading. Explicit restart and request-retry actions remain available. The repair checks the known comparison, reload paths and message counts; unexpected publication changes fail with `CLIENT_COMPATIBILITY_MISMATCH`. Other packages and versions are untouched. Repaired bytes receive their own content hash and revision.

`pnpm smoke:published` installs the actual `dsh-plugin@2.2.1` from npm through real HTTP, checks the Cordis patch-version admission, preserved patch bytes, the repaired Client artifact and sanitized metadata, and downloads all artifacts. The smoke reads the selected runtime’s generation and checkout’s Cordis version. It uses the explicit Cordis patch option because the publication declares 4.0.1 while the rc.2 host provides 4.0.5.

`@ljwei-stak/dsh-model-router@0.25.1` loads its Host command and Client workspace. Its Host version lookup uses a source-relative `../package.json` path that does not survive package bundling, so the UI reports an older backend despite the installed package being 0.25.1. Actual model routing and native CLI operations are not covered by this acceptance test.

`whale-girl@0.1.0` compiles with separate `schemastery` and `cosmokit` artifacts, but activation fails because the current DSH jobs service does not provide its requested `onJobDone` method. Its independent Client can still mount partially. Its ordinary `function apply()` returns a disposer that the current Cordis constructor invocation does not collect; this also reproduces directly in Node. Removing the package therefore leaves its Client DOM behind until a page reload. Its local assets and `import.meta.dirname` are additional unsupported requirements. This package is not usable on the current target; the acceptance test records the failure and residue explicitly rather than treating package installation as successful activation.

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
```

`test:browser` uses installed Google Chrome and the selected DSH checkout’s Playwright dependency. It starts temporary HTTP services, verifies v1/v2 commands, no-op file counts, deletion, separate npm dependencies and preflight rejection in the same Worker, then compares `tests/expected/browser-lifecycle.json`. Test artifacts and screenshots remain under ignored `.data/`.

`test:plugin-hub` first verifies HTTP request fields, progressive response streams and cancellation between a real dedicated Chrome Worker and a page-side provider. It then installs the published `dsh-plugin@2.2.1`, opens its settings UI, and installs through the actual catalog and confirmation buttons. It checks that closing the success dialog keeps the document and Worker alive, pending version records do not retire the settings slot, and the native switch starts enabled with one registration after an off/on cycle. It also exercises the HTTP task queue through virtual subprocesses. An isolated npm registry supplies a command-plugin fixture for add/update/remove and verifies the Worker’s `node:crypto.createHash` result. The actual `dsh-whale-widget@0.4.2` publication is rejected for `node:dns` without activation, while the installed fixture remains usable. Catalog and release metadata requests use the real remote services. It compares `tests/expected/plugin-hub.json` and requires network access.

The same test installs published `dsh-web-mobile@3.2.0` and updates it to `3.2.1` without restarting the Worker or reloading the page. At a 390px viewport with a coarse pointer, it verifies the drawer opens, closes through Escape and the backdrop, and introduces no horizontal overflow. It checks Client replacement leaves one style sheet and one set of controls, deletes a newly created test session through the plugin's native Fetch route, and verifies uninstall removes styles, controls and the Host route. Chrome touch emulation does not constitute Android WebView validation; the plugin's Node HTTP response compression is not supported by the synthetic Worker response.

`pnpm test:plugin-hub --host=<reachable-local-IP> --chinese --default-id` exercises a non-localhost HTTP origin, Chinese at startup, and the preview form's default plugin ID. The test checks that the native plugin manager can resolve both installed bundles and that the marketplace survives repeated opening, settings navigation, and mobile-plugin installation while open. Published bundle installs select the package in the native profile bundle list; Forge and the native plugin switch share one Loader entry. Updates remove legacy Forge patch rows and preserve a user-disabled selection. Source plugins without bundle metadata continue to use Forge patch rows. An installed package can be disabled or fail activation; package availability alone does not establish that it is running.

Unit/integration tests use temporary directories and OS-assigned ports. They cover immutable storage and concurrent publication, real Worker lowering, dependency separation, shared host versions, invalid paths and imports, compilation failure cleanup, HTTP downloads/CORS/limits, and admission release after failures. `smoke:npm` explicitly uses the network to install `is-odd@3.0.1` and transitive `is-number@6.0.0`, verifies separate artifacts and executes the resulting dependency mapping locally. The tests expect the selected DSH runtime's `lib/index.js` to exist. `test`, `smoke:npm`, `smoke:published`, `preview:prepare`, `test:browser`, and `test:plugin-hub` require `--dsh-root PATH` or the `DSH_ROOT` environment variable; they never infer a sibling checkout. The CLI flag takes precedence over the environment variable.

## Isolated DSH baseline validation

Run baseline validation from a separate Forge worktree and pass the same absolute DSH worktree path to every command. `preview:prepare` replaces `.data/preview` in its own Forge worktree; changing only `--dsh-root` does not change that output directory. Do not run it from an existing deployment’s checkout. Build the selected DSH artifacts first, then run Forge checks, unit tests and npm smokes, prepare its preview, and run Chrome acceptance. Browser acceptance verifies the prepared target’s generation and both package rosters against its freshly packed image before starting services. Use separate listener ports and an explicit `--storage` directory when starting a persistent test server. `preview:prepare --out-dir PATH` and `test:plugin-hub --preview-root PATH` select an independent preview directory, so this validation does not replace an existing preview.

A baseline with different Worker/compiler behavior must use its own `FORGE_GENERATION`; an exact package roster alone cannot reject an older plan that imports no host packages. Generate the target from the new image rather than editing old version strings. The rc.2 source baseline provides Cordis 4.0.5, so the existing optional Cordis patch admission remains sufficient for Hub 2.2.1’s exact 4.0.1 declaration. DSH prerelease and Client requirements retain their declared semver checks; no baseline-wide version relaxation is applied. The base release’s lowerer exports are present, but Forge integration, the Client roster and required implemented Node modules must be ported and built before integration tests can pass.
