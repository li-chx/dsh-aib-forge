# syntax=docker/dockerfile:1
FROM node:24-bookworm AS build

RUN npm install --global pnpm@11.28.5
WORKDIR /build/forge
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY scripts/dsh-path.mjs scripts/image-target.mjs scripts/prepare-container-runtime.mjs ./scripts/
RUN pnpm build

# Match this ref to the AIB frontend being deployed.
ARG DSH_REPOSITORY=https://github.com/li-chx/deepseek-harness-all-in-browser.git
ARG DSH_REF=ccec8aaac95174eb5020b919732354bf1df2bb2d
RUN git init /build/harness \
    && git -C /build/harness remote add origin "${DSH_REPOSITORY}" \
    && git -C /build/harness fetch --depth=1 origin "${DSH_REF}" \
    && git -C /build/harness checkout --detach FETCH_HEAD
RUN cd /build/harness \
    && pnpm install --frozen-lockfile \
    && pnpm run build:artifacts
RUN node scripts/prepare-container-runtime.mjs \
      --dsh-root /build/harness --out-dir /build/runtime \
    && pnpm prune --prod

FROM node:24-bookworm-slim AS runtime
RUN npm install --global pnpm@11.28.5 \
    && mkdir -p /var/lib/dsh-forge/artifacts \
    && chown -R node:node /var/lib/dsh-forge
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /build/forge/package.json ./
COPY --from=build /build/forge/node_modules ./node_modules
COPY --from=build /build/forge/dist ./dist
COPY --from=build /build/runtime ./runtime
USER node
EXPOSE 36936
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:36936/v1/target').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "dist/main.js"]
CMD ["--target", "/app/runtime/target.json", "--transformer", "/app/runtime/transformer.mjs", "--host", "0.0.0.0", "--port", "36936", "--storage", "/var/lib/dsh-forge/artifacts"]
