FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm install
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# The base image ships a non-root "node" user at uid/gid 1000, which matches
# a typical single-user Linux workstation's first account. Override
# APP_UID/APP_GID at build time (--build-arg) to match your own host user if
# it differs, so files this container writes into bind-mounted host
# directories (like the SQLite index under /data) come out host-owned, not
# root-owned.
ARG APP_UID=1000
ARG APP_GID=1000
RUN if [ "$APP_UID" != "1000" ] || [ "$APP_GID" != "1000" ]; then \
      groupmod -g "$APP_GID" node && usermod -u "$APP_UID" -g "$APP_GID" node; \
    fi

COPY --from=build --chown=node:node /app/backend/package.json backend/package.json
COPY --from=build --chown=node:node /app/backend/dist backend/dist
COPY --from=build --chown=node:node /app/frontend/dist frontend/dist
# npm workspaces hoist all dependencies (including better-sqlite3's native
# build) into the root node_modules — there is no separate backend/node_modules.
# Node's module resolution walks up from backend/dist/ and finds this root
# copy automatically.
COPY --from=build --chown=node:node /app/node_modules node_modules

RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 4173
CMD ["node", "backend/dist/index.js"]
