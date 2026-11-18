# The web app: built once, served by nginx, which also forwards /v1 to the API.
# Build from the repository root: docker build -f deploy/docker/web.Dockerfile -t dmc/web .
FROM node:22-slim AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @dmc/app-web run build

FROM nginx:1.27-alpine
COPY deploy/docker/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /src/apps/web/dist /usr/share/nginx/html
ENV DMC_API_URL=http://api:3000
EXPOSE 8080
