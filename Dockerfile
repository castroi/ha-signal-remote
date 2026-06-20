# syntax=docker/dockerfile:1

# Base image pinned by digest (design §6 A05). node:20-alpine.
ARG NODE_IMAGE=node@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

# ---- build stage ----
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Pin pnpm to the Node-20-compatible line.
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# Prune to production dependencies only.
RUN pnpm prune --prod

# ---- runtime stage ----
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Copy only what the runtime needs; ownership to the built-in non-root `node` user.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# Drop to the non-root user (design §6 A05).
USER node

# No inbound ports: the bridge only opens outbound connections (design §3).
# Entry runs the compiled bridge composition root.
CMD ["node", "dist/index.js"]
