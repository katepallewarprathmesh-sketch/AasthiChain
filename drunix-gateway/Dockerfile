# AasthiChain Drunix Gateway + UMI settlement rail (Go).
#
# Serves /drunix/*, /fraud/* and /umi/* (RBI Unified Market Interface pattern —
# SEBI Demat 2.0 atomic DvP in wholesale CBDC, simulation).
#
# Build from the drunix-gateway directory:
#   docker build -t aasthi-umi ./drunix-gateway
#   docker run -p 21100:21100 aasthi-umi
#
# PaaS hosts inject $PORT; the binary honours it (then DRUNIX_PORT, then 21100).

FROM golang:1.22-alpine AS build
WORKDIR /src
# go.mod/go.sum first so dependency layers cache
COPY go.mod go.su[m] ./
RUN go mod download || true
COPY . .
# Stamp the build with its commit so the running service can report which
# revision is live (GET /health -> build.commit). Hosts that expose the commit
# at runtime (Render sets RENDER_GIT_COMMIT) are picked up without this.
ARG GIT_COMMIT=""
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath \
    -ldflags="-s -w -X github.com/katepallewarprathmesh-sketch/AasthiChain/drunix-gateway.BuildCommit=${GIT_COMMIT}" \
    -o /out/gateway ./cmd/gateway

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /
COPY --from=build /out/gateway /gateway
ENV PORT=21100 \
    UMI_ENABLED=true \
    UMI_SEED_DEMO=true
EXPOSE 21100
USER nonroot:nonroot
ENTRYPOINT ["/gateway"]
