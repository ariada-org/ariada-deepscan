# One Dockerfile for every microservice:  docker build --build-arg SERVICE=verifier -t you/deepscan-verifier .
# Stage 1 bundles the service (and the shared packages it imports) into a single file with esbuild.
FROM node:22-alpine AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages
COPY services ./services
COPY scripts/bundle.mjs ./scripts/bundle.mjs
RUN pnpm install --frozen-lockfile
ARG SERVICE
RUN test -n "$SERVICE" && node scripts/bundle.mjs "$SERVICE"

# Stage 2: tiny runtime — Node + one JS bundle, non-root, no package manager, no sources.
FROM node:22-alpine
ARG SERVICE
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build /src/services/${SERVICE}/dist/ ./
COPY fixtures /app/fixtures
USER node
EXPOSE 8080
CMD ["node", "index.js"]
