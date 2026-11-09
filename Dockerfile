# syntax=docker/dockerfile:1

# ---- Build stage: compile TypeScript, including devDependencies ----
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Runtime stage: production deps + compiled JS only ----
FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

# Run as a non-root user
RUN useradd --create-home --shell /bin/bash appuser \
    && chown -R appuser:appuser /app
USER appuser

# Default: run as a Cloud Run JOB - each execution processes one batch and
# exits (see src/index.ts --once). Cloud Scheduler decides how often (deploy/).
#
# The same image also serves the HTTP API; override the command:
#   node dist/server.js        (listens on $PORT, default 8080; needs API_KEY)
EXPOSE 8080
CMD ["node", "dist/server.js"]
