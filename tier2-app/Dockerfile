# syntax=docker/dockerfile:1
# Multi-stage, ordered so the expensive `npm ci` layer caches unless the lockfile changes.
# This is what makes warm builds fast — and what Blacksmith's persistent layer cache
# accelerates far more than GitHub's network-backed GHA cache.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/index.cjs"]
