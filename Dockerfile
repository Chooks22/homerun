FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS go-builder

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
COPY package.json ./

ARG TARGETOS
ARG TARGETARCH
RUN VERSION="$(sed -n 's/^[[:space:]]*"version": "\(.*\)",*$/\1/p' package.json)"; \
    CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" go build -trimpath \
    -ldflags "-s -w -X github.com/orochibraru/homerun/internal/buildinfo.Version=${VERSION}" \
    -o /out/homerun-worker ./cmd/worker

FROM go-builder AS cli-builder

ARG TARGETOS
ARG TARGETARCH
ARG HOMERUN_VERSION=""
RUN VERSION="${HOMERUN_VERSION:-$(sed -n 's/^[[:space:]]*"version": "\(.*\)",*$/\1/p' package.json)}"; \
    CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" go build -trimpath \
    -ldflags "-s -w -X github.com/orochibraru/homerun/internal/buildinfo.Version=${VERSION}" \
    -o /out/homerun ./cmd/cli

FROM alpine:3 AS cli

RUN apk add --no-cache ca-certificates

COPY --from=cli-builder /out/homerun /usr/local/bin/homerun

CMD ["homerun", "--help"]

FROM oven/bun:1.4.3-alpine AS deps-base

ENV BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP2_CLIENT=1

WORKDIR /app

COPY package.json bun.lock* /app/
COPY patches /app/patches

FROM deps-base AS deps

RUN bun install --frozen-lockfile --ignore-scripts

FROM deps AS app-builder

COPY . .

COPY --from=deps /app/node_modules /app/node_modules

RUN bun run build

# adapter-bun compiles the app to a single standalone binary
# (`build/server`) that bundles every JS dependency, so the runtime image
# needs no `node_modules` and no Bun runtime to serve. It stays on
# `oven/bun:1.4.2-alpine` only because the binary is musl-linked (compiled on the
# Alpine builder above) and entrypoint.sh relies on this image's baked-in
# `bun` user plus `su-exec` / busybox `addgroup`.
FROM oven/bun:1.4.3-alpine AS app

RUN apk add --no-cache ca-certificates su-exec

WORKDIR /app

COPY --from=app-builder --chown=bun:bun /app/build /app/build
COPY --from=app-builder --chown=bun:bun /app/drizzle/ /app/drizzle
COPY --from=go-builder /out/homerun-worker /usr/local/bin/homerun-worker
COPY internal/installer/compose.yaml internal/installer/compose.swarm.yaml /app/compose/
COPY tools/docker/entrypoint.sh /entrypoint.sh
COPY --chown=bun:bun tools/docker/healthcheck.sh /app/build/healthcheck
RUN chmod +x /entrypoint.sh /app/build/healthcheck

EXPOSE 3000

ENV BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP2_CLIENT=1
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV BODY_SIZE_LIMIT=Infinity
ENV APP_ENV=production
ENV ORIGIN=http://localhost:3000
ENV STORAGE_BASE_PATH=/app/data

ARG HOMERUN_APP_VERSION=""
ENV HOMERUN_APP_VERSION=$HOMERUN_APP_VERSION

RUN mkdir -p /app/data /app/traefik-dynamic && chown -R bun:bun /app/data /app/traefik-dynamic

VOLUME /app/data

HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 \
    CMD ["/app/build/healthcheck"]

ENTRYPOINT ["/entrypoint.sh"]
CMD ["/app/build/server"]

FROM alpine:3 AS worker

RUN apk add --no-cache ca-certificates wget

COPY --from=go-builder /out/homerun-worker /usr/local/bin/homerun-worker

ENV WORKER_PORT=7420
ENV DOCKER_SOCKET_PATH=/var/run/docker.sock

EXPOSE 7420

HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 \
    CMD ["sh", "-c", "wget --no-verbose --tries=1 --spider http://0.0.0.0:7420/v1/health || exit 1"]

ENTRYPOINT ["/usr/local/bin/homerun-worker"]
