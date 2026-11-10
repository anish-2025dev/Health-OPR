# Production-style image for the API. Build from the repository root:
#   docker build -f apps/api/Dockerfile -t healthos-api .
FROM node:22-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace apps/api --include-workspace-root=false --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY apps/api ./apps/api
USER node
EXPOSE 4000
CMD ["node", "apps/api/src/server.js"]
