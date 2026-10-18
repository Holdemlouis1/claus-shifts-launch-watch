# Claus Shifts · Launch Watch server (Go). Standard library only: no dependencies, no build-time downloads, no secrets.
# Builder pinned to the same golang digest the Claus Network's own OCI verification fixture uses.
FROM docker.io/library/golang@sha256:aee43c3ccbf24fdffb7295693b6e33b21e01baec1b2a55acc351fde345e9ec34 AS build
WORKDIR /src
COPY go.mod main.go watch.go ./
RUN CGO_ENABLED=0 GOTOOLCHAIN=local go build -trimpath -ldflags="-s -w -buildid=" -o /server .
FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /server /server
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/server"]
