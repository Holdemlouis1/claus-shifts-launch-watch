# Claus Shifts · Launch Watch server (Go), built from the repository root.
# The Claus Network builds this file: its source snapshot must carry the repository's own paths, so this
# Dockerfile copies the Go sources from server-go/. server-go/Dockerfile is the same build with server-go/ as context.
# Standard library only: no dependencies, no build-time downloads, no secrets.
FROM docker.io/library/golang@sha256:aee43c3ccbf24fdffb7295693b6e33b21e01baec1b2a55acc351fde345e9ec34 AS build
WORKDIR /src
COPY server-go/go.mod server-go/main.go server-go/watch.go ./
RUN CGO_ENABLED=0 GOTOOLCHAIN=local go build -trimpath -ldflags="-s -w -buildid=" -o /server .
FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /server /server
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/server"]
