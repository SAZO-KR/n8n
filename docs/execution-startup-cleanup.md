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

