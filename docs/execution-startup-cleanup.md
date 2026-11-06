# Execution startup failure cleanup

## Scope

An execution is registered before static data is loaded, execution context is
created, and the execution is marked running. In regular mode, these operations
currently precede the error handler. A database timeout can therefore leave the
registered execution and its input reachable without a workflow or timeout to
finish it.

Startup failures use the existing execution lifecycle to record errors and
release registered state. A second failure while recording the error must not
prevent in-memory cleanup or leave a webhook response promise pending. Error
persistence can only complete when the database is available.

## Acceptance criteria

- Static-data, execution-context, and running-state failures reach the error
  lifecycle and release the registered execution and concurrency capacity.
- A webhook response promise rejects when startup fails, including when error
  persistence also fails. The caller receives an error.
- Credential denial prevents workflow execution and releases registered state
  even if recording the denied execution fails.
- Cleaning up one failed startup does not cancel or remove another execution.
- Existing successful, waiting, resumed, and cancelled execution behavior remains
  covered by the related execution tests.

## PostgreSQL load verification

Use a disposable local PostgreSQL server, with a pool of two and the default
20-second connection timeout. The opt-in test runs 295 synthetic workflows in
batches of five every two seconds, then exhausts both real pool connections.
It checks both recovery before error persistence and continuing DB failure.

From `packages/cli`, with the test server's connection variables configured:

```sh
DB_TYPE=postgresdb DB_POSTGRESDB_POOL_SIZE=2 pnpm exec jest \
  --testRegex='postgres-startup.integration.ts$' --runInBand --no-coverage
```

The workflow executes two local nodes; it does not call external business
services. A continuing DB outage can leave the persisted row running even
though its in-memory execution and response promise are released.

## Container build verification

The source Dockerfile supports `BUILD_CONCURRENCY` (default 10, Turbo's default).
For an amd64 build under emulation, use `--build-arg BUILD_CONCURRENCY=1` to avoid
Turbo log-directory `EINTR` failures observed during concurrent package builds.
The build step allows 6 GiB of V8 heap for the node-definition compiler worker,
which exceeded the default heap during a clean amd64 build. These settings apply
to the builder; the final runtime image does not inherit them.
Manifest trimming uses Node's JSON parser instead of an optional `jq` binary,
so a missing tool cannot silently replace the root manifest with an empty file.

```sh
docker build --platform=linux/amd64 --build-arg BUILD_CONCURRENCY=1 \
  -t n8n-startup-test -f docker/images/n8n-custom/Dockerfile .
```

