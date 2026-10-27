# Forge compilation target

This directory contains backend compilation inputs for AIB's `dsh-worker-rc2-8` generation, exported from frontend commit `ccec8aaac95174eb5020b919732354bf1df2bb2d` in [deepseek-harness-all-in-browser](https://github.com/li-chx/deepseek-harness-all-in-browser). It contains no frontend page, browser filesystem image, user data or credentials.

- `target.json` records the protocol, generation, shared packages, exact Host/Client package versions and available Client module names.
- `transformer.mjs` exports the matching JavaScript module transformer and module proxy declarations. Acorn is bundled so this compiler does not import the frontend checkout at runtime.
- `LICENSE.DeepSeek` and `LICENSE.acorn` retain the licenses for the bundled compiler code.

Docker copies these files directly into the Forge image. Installing the backend does not require an AIB checkout. Deploy the frontend separately to EO or another static host; configure `FORGE_ORIGIN` with its public origin.

## Refreshing the compilation target

Maintainers must update this pair together when changing the frontend's Worker generation, module transformer or provided package/module roster. In a development environment, build the intended AIB checkout first, then run from the Forge repository root:

```sh
pnpm install --frozen-lockfile
node scripts/prepare-container-runtime.mjs --dsh-root /absolute/path/to/deepseek-harness --out-dir runtime
```

Update the source commit and generation recorded above, review the generated files and license notices, verify a plugin build against the corresponding frontend, then commit this directory with the backend. Deployment servers only update the backend checkout and run Docker Compose.
