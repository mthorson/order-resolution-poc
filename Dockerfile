FROM node:26.11.1-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
COPY scripts/verify-records.ts ./scripts/
COPY web ./web
COPY tests ./tests
COPY tsconfig.json vite.config.ts playwright.config.ts ./
RUN npm run check && npm run build:ui

FROM node:26.11.1-trixie-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:26.11.1-trixie-slim AS runtime
# Package tooling is needed only in the build/dependency stages.
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules /opt/yarn* \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/corepack
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts/verify-records.ts ./scripts/
COPY fixtures ./fixtures
COPY evals ./evals
COPY --from=build /app/dist ./dist
RUN mkdir /app/runs && chown node:node /app/runs
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/serve-cli.ts", "--demo", "--host", "0.0.0.0", "--origin", "http://localhost:3000"]
