# CCH edge executor
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
BIN := bin/edge

.PHONY: build test lint fmt docker run

build:
	CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$(VERSION)" -o $(BIN) ./cmd/edge

test:
	go test -race -count=1 ./...

lint:
	go vet ./...
	@test -z "$$(gofmt -l .)" || (echo "gofmt needed:"; gofmt -l .; exit 1)

fmt:
	gofmt -w .

docker:
	docker build -f Dockerfile --build-arg VERSION=$(VERSION) -t cch-edge:$(VERSION) .

run: build
	./$(BIN)
