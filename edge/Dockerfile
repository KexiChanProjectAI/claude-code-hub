# Build context: the edge/ directory (see Makefile `docker` target).
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/edge ./cmd/edge

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/edge /edge
VOLUME ["/var/lib/cch-edge/outbox"]
EXPOSE 13580
USER nonroot:nonroot
ENTRYPOINT ["/edge"]
