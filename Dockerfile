# --- build stage ---
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime stage ---
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
# Reminders are scheduled in Jakarta wall-clock time and the code reads the
# local clock. Alpine ships no zoneinfo, so without tzdata the TZ below is
# accepted and silently ignored — the container stays on UTC and every reminder
# fires 7 hours off. assertJakarta() logs an error at boot if that happens.
RUN apk add --no-cache tzdata
ENV TZ=Asia/Jakarta
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# SQLite data dir — writable by uid 1000 even when no host volume is mounted.
# In prod this path is a bind mount (see compose.prod.yaml).
RUN mkdir -p /app/data && chown node:node /app/data
# Drop root — the node image ships an unprivileged `node` user (uid 1000).
USER node
CMD ["node", "dist/index.js"]
