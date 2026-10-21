FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx tsc --noEmit && npx vite build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 UPLOADS_DIR=/data/uploads
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY src ./src
COPY drizzle ./drizzle
COPY scripts ./scripts
COPY plugin ./plugin
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "--import", "tsx", "src/server/index.ts"]
