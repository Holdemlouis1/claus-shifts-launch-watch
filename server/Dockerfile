# Claus Shifts · Launch Watch server. No dependencies, no build step, no secrets.
FROM docker.io/library/node@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
WORKDIR /app
COPY watch.mjs server.mjs ./
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
