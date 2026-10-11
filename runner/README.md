# SDVsolution build runner

Claims queued build jobs, regenerates C code and unit tests from the **frozen Behavior Model in the chosen baseline**,
compiles with `-std=c99 -Wall -Wextra -Wconversion -Werror`, runs the generated tests, and reports the result and files
back to the app. Results appear in **Behavior Models → Builds**, and the JUnit XML can be imported into Test Cases.

## Run it

```bash
SDV_API=https://app.sdvsolution.com SDV_RUNNER_TOKEN=sdvr_xxx node runner/runner.mjs
```

| Variable / flag | Meaning |
|---|---|
| `SDV_API` | App base URL (required) |
| `SDV_RUNNER_TOKEN` | Token from **Behavior Models → Build runners** (shown once; revocable) |
| `CC` | C compiler, default `gcc` |
| `SDV_POLL_SEC` | Idle poll interval, default 10 |
| `--once` / `--drain` | Take one job and exit / process the queue and exit |

Or with Docker (from the repository root): `docker build -f runner/Dockerfile -t sdv-runner .`

## Managed vs customer-run

One program, two deployments. A **customer runner** holds a token registered by that company's owner/admin and only ever
receives that company's jobs. The **managed fleet** uses operator-created tokens. When a company has a recently active
customer runner, its builds are routed there (their code and toolchain stay on their infrastructure).

## What it checks, in order

1. **integrity** — the queued model's hash must match; a tampered job is rejected.
2. **gate** — the model must be approved and QM-confirmed (re-checked here, independently of the server).
3. **generate** — deterministic C + tests from the model.
4. **compile** — strict warnings as errors.
5. **unit-tests** — all generated tests must run and pass; the count must match what was generated.
6. **static-analysis, coverage** — *recorded as `not-run`* until item 6 adds them. A result never implies they passed.
7. **package** — manifest hash; generated files and `results.xml` are uploaded.

## Security notes

- The runner holds **no database key**, only a revocable token scoped to one company (or the managed fleet).
- Each job runs in a fresh temp directory that is deleted afterwards. The container runs as a non-root user.
- Code is compiled and **executed** (the generated tests), so customer-run runners should use an isolated host or container.
  The managed fleet needs per-job sandboxing (no network, resource limits) before it is opened to untrusted tenants —
  tracked as a follow-up; today the model comes only from an approved baseline, and the generator is deterministic.
