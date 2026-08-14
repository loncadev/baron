# syntax=docker/dockerfile:1
#
# Baron's MCP server as a container. Two audiences, one image:
#
#   - Indexers (Glama and the Docker MCP Catalog) build it in a sandbox with no credentials and no
#     project mounted, and judge the server by whether it starts and answers `tools/list`. Glama
#     infers a Dockerfile when a repo ships none, and withholds distribution — the profile page
#     survives, but the server stops appearing in search and category listings — when that inferred
#     build fails. Shipping our own takes us off the inference path.
#   - People who would rather run a container than `npx`, who mount their project over /project.
#
# The build context is the repo ROOT, not packages/mcp-server: this is a pnpm workspace, so the
# lockfile, the workspace manifest and every sibling package have to be reachable.

FROM node:22-alpine AS builder
RUN corepack enable
WORKDIR /src

# Manifests first so a source-only edit does not invalidate the install layer.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY packages/providers/package.json packages/providers/
COPY packages/recipes/package.json packages/recipes/
COPY packages/knowledge-loop/package.json packages/knowledge-loop/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/cli/package.json packages/cli/
COPY packages/conformance/package.json packages/conformance/
COPY packages/adapters/azure-devops/package.json packages/adapters/azure-devops/
COPY packages/adapters/github/package.json packages/adapters/github/
COPY packages/adapters/slack/package.json packages/adapters/slack/
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY . .
RUN pnpm build

# `deploy` resolves the workspace links into a self-contained tree, so the runtime stage needs no
# pnpm and no workspace layout. --prod drops the dev toolchain (tsup, vitest, biome) that dominates
# the install.
RUN pnpm --filter @lonca/baron-mcp-server deploy --prod --legacy /app

# The deployed tree is a private publish in all but name, so it needs the same transform a publish
# applies. Without this the copied workspace packages stay in DEV mode and Node is handed TypeScript.
RUN node scripts/apply-publish-config.mjs /app

FROM node:22-alpine AS runtime
ENV NODE_ENV=production

# The server only ever reads the project it is pointed at; nothing needs root.
RUN addgroup -S baron && adduser -S baron -G baron
WORKDIR /app
COPY --from=builder --chown=baron:baron /app ./

# A stdio MCP server that cannot start is indistinguishable from a broken image, and the server
# refuses to start without a policy (POLICY_NOT_FOUND). Baron's own committed policy ships as the
# default root so a bare `docker run` starts and can be introspected. It is policy only — no
# credentials are baked in, and every call against it fails loudly for want of them.
COPY --from=builder --chown=baron:baron /src/.baron /app/.baron
ENV BARON_ROOT=/app

# Mount your project here and point the server at it. Built locally on purpose: no image is
# published anywhere, because the one consumer that needs a container (Glama) builds it in its own
# sandbox, and the Docker catalog — the surface a published image would serve — is deliberately last.
#   docker build -t baron-mcp .
#   docker run -i --rm -v "$PWD:/project" -e BARON_ROOT=/project baron-mcp
VOLUME ["/project"]

USER baron
# stdio, not a port: the client speaks JSON-RPC over stdin/stdout. Logs go to stderr — anything on
# stdout corrupts the stream.
ENTRYPOINT ["node", "dist/bin.js"]
