# Builds the static web bundle and serves it with nginx. Build from the repository root:
#   docker build -f apps/web/Dockerfile --build-arg VITE_API_BASE_URL=https://api.example.com/api/v1 -t healthos-web .
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace apps/web --include-workspace-root=false
COPY apps/web ./apps/web
ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN npm run build --workspace apps/web

FROM nginx:1.27-alpine
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
