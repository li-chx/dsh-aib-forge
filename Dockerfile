# syntax=docker/dockerfile:1
FROM node:24-bookworm AS build

RUN npm install --global pnpm@11.28.5
WORKDIR /build/forge
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod
COPY runtime ./runtime

FROM node:24-bookworm-slim AS runtime
RUN npm install --global pnpm@11.28.5 \
    && mkdir -p /var/lib/dsh-forge/artifacts \
    && chown -R node:node /var/lib/dsh-forge
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /build/forge/package.json ./
COPY --from=build /build/forge/node_modules ./node_modules
COPY --from=build /build/forge/dist ./dist
COPY --from=build /build/forge/runtime ./runtime
COPY LICENSE ./LICENSE
USER node
EXPOSE 36936
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:36936/v1/target').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "dist/main.js"]
CMD ["--target", "/app/runtime/target.json", "--transformer", "/app/runtime/transformer.mjs", "--host", "0.0.0.0", "--port", "36936", "--storage", "/var/lib/dsh-forge/artifacts"]
