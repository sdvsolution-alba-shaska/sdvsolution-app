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

On Windows with Docker Desktop, double-click `runner/start-runner.cmd`: it builds the image, asks for the token without showing it, and starts the runner.

## Managed vs customer-run

One program, two deployments. A **customer runner** holds a token registered by that company's owner/admin and only ever
receives that company's jobs. The **managed fleet** uses operator-created tokens. When a company has a recently active
customer runner, its builds are routed there (their code and toolchain stay on their infrastructure).

## What it checks, in order

1. **integrity** — the queued model's hash must match; a tampered job is rejected.
2. **gate** — the model must be approved and QM-confirmed (re-checked here, independently of the server).
3. **generate** — deterministic C + tests from the model.
4. **compile** — strict warnings as errors.
5. **unit-tests** — all generated tests must run and pass; the count must match what was generated. The test build defines
   `SDV_UNIT_TEST`, which enables test-only hooks (never compiled into production code) so the tests can reach defensive paths.
6. **static-analysis** — the production sources only, *without* the test hooks, with a wider warning set than the build
   (`-Wshadow -Wswitch-default -Wnull-dereference -Wmissing-prototypes …`) plus GCC's `-fanalyzer` when the compiler has it.
   Any finding fails the build. If `cppcheck` is on `PATH` it is run as well (`CPPCHECK` to override). **MISRA is always
   reported as `not-run`** — a clean analysis is not MISRA compliance; that needs a licensed checker (see below).
7. **coverage** — a separate instrumented build runs the same tests; `gcov` reports **line, branch and condition (MC/DC-style)**
   coverage of the generated production code. Condition coverage needs GCC 14+; on older compilers it is reported as
   *unavailable*, never as 100%. In Phase 1 coverage is **informational** — it does not fail the build, but the result says
   plainly when it is incomplete and lists the uncovered code. Requires `gcov` next to the compiler (`GCOV` to override).
8. **package** — manifest hash; generated files, `results.xml`, `testcases.json`, `analysis.json` and `coverage.json` are uploaded.

Failed builds stop at the failing step and gather no further evidence, so a failing build is never mistaken for a release candidate.

### Open policy decisions
- **Coverage threshold:** should the build fail below some percentage? Today it is informational. The generated tests currently
  reach 100% on the pilot, so a threshold of 100% for generated code would be achievable — but functions the test solver can't
  fully cover would then be blocked until manual tests can be added.
- **MISRA:** which checker to support (customer-licensed). The step exists as "not-run" and is the place to plug one in.

## Security notes

- The runner holds **no database key**, only a revocable token scoped to one company (or the managed fleet).
- Each job runs in a fresh temp directory that is deleted afterwards. The container runs as a non-root user.
- Code is compiled and **executed** (the generated tests), so customer-run runners should use an isolated host or container.
  The managed fleet needs per-job sandboxing (no network, resource limits) before it is opened to untrusted tenants —
  tracked as a follow-up; today the model comes only from an approved baseline, and the generator is deterministic.
