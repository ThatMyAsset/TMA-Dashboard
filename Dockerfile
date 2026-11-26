FROM golang:1.23.5-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/control-plane ./cmd/control-plane

FROM alpine:3.21.2
RUN addgroup -S -g 10001 tma && adduser -S -D -H -u 10001 -G tma tma
COPY --from=build /out/control-plane /control-plane
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["/control-plane"]
