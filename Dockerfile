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
COPY --from=build /app/backend/package.json backend/package.json
COPY --from=build /app/backend/dist backend/dist
COPY --from=build /app/frontend/dist frontend/dist
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/backend/node_modules backend/node_modules

EXPOSE 4173
CMD ["node", "backend/dist/index.js"]
