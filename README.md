# kanasha-flow

A YAML-driven API test runner built on top of Postman collections. Chain requests within a flow, validate YAML before running, and mix automated and interactive steps in a single tool.

Postman **collections** define the available endpoints. The **runner** executes them, chains variables within a run, and orchestrates scenarios.

> Project files (`collections/`, `environments/`, `tests/`) are gitignored. Files prefixed with `example` are the exception — copy, rename, and adapt them as your starting point.

## Why not plain Newman?

If your tests are simple one-shot requests, Newman with a shell script is probably enough.

kanasha-flow is built for a specific problem: **flows with multiple steps that depend on each other within the same run**. Each run starts from a clean state — reproducible by default, safe for CI.

| | Plain Newman | kanasha-flow |
|---|---|---|
| Chain variables within a flow | ✗ | ✓ via `extract` + `body_override` |
| Setup and teardown per flow | ✗ | ✓ |
| Pause and prompt for user input (e.g. email/SMS code) | ✗ | ✓ via `human-input` |
| YAML schema validation before running | ✗ | ✓ |
| JUnit XML output for CI | ✗ | ✓ via `--junit` |

Newman is still used under the hood — the runner calls it per individual request. What kanasha-flow adds is the orchestration layer on top.

---

## How it works

```
collections/          environments/          tests/
    │                      │                    │
    │   (Postman JSON)      │   (URLs, creds)    │   (YAML flow)
    └──────────────────┐    └──────────┐         │
                       ▼              ▼          ▼
                    ┌─────────────────────────────────┐
                    │            runner.js             │
                    │                                  │
                    │  1. validate flow YAML           │
                    │  2. load environment             │
                    │  3. run setup steps              │
                    │  4. execute steps in order       │
                    │     └─ call Newman per request   │
                    │     └─ extract variables         │
                    │     └─ pause for human-input     │
                    │  5. run teardown steps           │
                    │  6. generate report (--report)   │
                    └─────────────────────────────────┘
```

Each run starts with a clean state — variables are scoped to the current run and not persisted between runs.

---

## Getting started

### 1. Install dependencies

```bash
cd runner && npm install
```

### 2. Set up your collection

Create `collections/<name>.postman_collection.json` with your API endpoints. Use `collections/example.postman_collection.json` as a starting point.

> The runner automatically loads every collection found in that folder — no registration needed.

### 3. Set up your environment

Create `environments/local.postman_environment.json` with base variables (URLs, credentials, etc.). Use `environments/example.postman_environment.json` as a starting point.

```json
{
  "id": "env-local",
  "name": "Local",
  "values": [
    { "key": "baseUrl", "value": "http://localhost:8080", "enabled": true }
  ],
  "_postman_variable_scope": "environment"
}
```

For additional environments (staging, production), duplicate the file and pass its name as the second argument when running.

### 4. Write a flow

Create `tests/<category>/name.yml`. Use `tests/example/get-google.yml` as a starting point.

```yaml
name: "My first test"
description: "Checks that the health endpoint responds with 200."
stop_on_failure: true

steps:
  - name: "Health check"
    collection: my-api
    folder: "Health"
    request: "GET /health"
```

The `collection` name matches the JSON filename without the extension. `folder` and `request` must match exactly the names in Postman.

### 5. Run

```bash
# Single flow
./scripts/run-test.sh <category>/name.yml

# All flows
./scripts/run-all-tests.sh

# CI/CD — bootstrap + skip human-input flows, emit JUnit XML
./scripts/run-all-tests.sh local --auto --junit

# Fresh start (clear persisted state, then run everything)
./scripts/run-all-tests.sh local --fresh --auto --junit
```

---

## Running tests

### Single request

Runs one request by name using the current state as context.

```bash
# Syntax
./scripts/run-request.sh <collection> "<folder>" "<request>" [environment]

# Examples
./scripts/run-request.sh my-api "Auth" "Login"
./scripts/run-request.sh my-api "Users" "Get User"

# List all available requests
cd runner && node runner.js --list
```

### Flow

Runs a sequence of requests declared in YAML, with automatic variable chaining and human-input support.

```bash
./scripts/run-test.sh auth/login-success.yml
./scripts/run-test.sh auth/login-success.yml local
./scripts/run-all-tests.sh
./scripts/run-all-tests.sh local
```

#### Flags

| Flag | Description |
|------|-------------|
| `--auto` | Skip flows that contain `human-input` steps — useful for CI/CD |
| `--report` | Generate a JSON + HTML report in `reports/` after the run |
| `--junit` | Generate a JUnit XML report in `reports/` (GitLab/GitHub CI integration) |
| `--fresh` | Clear persisted state (`.run-state.json`) before running — use for a clean start |

Flags are combinable and work on both `run-test.sh` and `run-all-tests.sh`:

```bash
# Automated tests only
./scripts/run-all-tests.sh local --auto

# With report
./scripts/run-test.sh auth/login-success.yml local --report

# CI pipeline
./scripts/run-all-tests.sh local --auto --junit
```

**`--junit`** generates `reports/<timestamp>_<flow>.xml` alongside the JSON and HTML files. Publish it in your CI pipeline:

```yaml
# GitLab CI
artifacts:
  reports:
    junit: api-tests/reports/*.xml

# GitHub Actions
- uses: actions/upload-artifact@v4
  with:
    path: api-tests/reports/*.xml
```

When `--auto` is used on a flow with `human-input` steps, the runner skips it and exits with code 0 (not counted as a failure):

```
⏭  Skipping "onboarding/full-email-flow.yml" — contains human-input steps (--auto)
```

Reports are saved in `reports/` with a timestamp in the filename (`YYYY-MM-DDTHH-mm_<flow>.[json|html|xml]`) and are gitignored.

### Ad-hoc scenario

Any combination of calls is a valid test:

```bash
./scripts/run-request.sh my-api "OAuth2" "Get Token"
./scripts/run-request.sh my-api "Roles" "List User Roles"
```

---

## Variable chaining

The variable resolution order within a run:

1. `environments/local.postman_environment.json` — base values (URLs, credentials, etc.)
2. `.run-state.json` — persisted state from previous flows (see below)
3. `pm.environment.set()` in collection test scripts — automatic after each request
4. `extract` field in YAML — manual JSONPath extraction
5. `human-input` steps — value typed by the user in the terminal

### State persistence

After each flow runs, all variables are persisted to `.run-state.json` (gitignored). When the next flow starts, this state is merged on top of the environment values — state takes precedence.

This means the bootstrap flow can run once and set `applicationGroupId`, `applicationId`, `userAccessToken`, etc., and all subsequent flows pick them up without re-authenticating from scratch.

Use `--fresh` to clear the state file and force a clean restart (e.g., after a database reset).

---

## Flow format (YAML)

### Type: request

```yaml
name: "Flow name"
description: "What this flow tests"
stop_on_failure: true

steps:
  - name: "Descriptive name"
    collection: my-api
    folder: "Folder name in the collection"
    request: "Exact request name"

    # Override body fields (supports {{variable}})
    body_override:
      code: "{{challengeCode}}"

    # Extract values from the response into state
    extract:
      myVar: "$.nested.field"
```

### Type: human-input

```yaml
	  - name: "Enter the received code"
	    type: human-input
	    prompt: "Type the 6-digit code received by email/SMS"
	    store: challengeCode
	    # Optional: fail the step unless the entered value matches exactly.
	    equals: OK
	```

### Type: db-query

Executes a read-only SQL `SELECT` against a PostgreSQL database. Useful for reading data that is not exposed via an API (e.g. NOOP challenge codes in test environments).

```yaml
  - name: "Get challenge code from DB"
    type: db-query
    connection: "{{dbCommunicationUrl}}"   # full postgresql:// connection string
    query: "SELECT validation_code FROM tb_application_challenge WHERE external_id = '{{challengeId}}' LIMIT 1"
    extract:
      challengeCode: "$.validation_code"   # column name from first row
```

The `connection` string is resolved against the current environment variables, so it can reference `{{dbSomeServiceUrl}}` defined in your environment file.

### allow_failure

Any step (of any type) can be marked `allow_failure: true`. If the step fails its assertions or throws an error, it is logged as a warning (`⚠️`) and does not count toward the flow's failure count or trigger `stop_on_failure`.

```yaml
  - name: "Create Application Group"
    collection: authentication-service
    folder: "Application Groups"
    request: "Create Application Group"
    allow_failure: true   # silently skipped if it already exists (409)
```

This is the mechanism behind idempotent bootstrap flows.

### Setup and teardown

Use `setup` and `teardown` to make flows reproducible and self-cleaning:

```yaml
name: "Create and delete a user"
stop_on_failure: true

setup:
  - name: "Login"
    collection: authentication-service
    folder: "Auth Flows"
    request: "Login"

steps:
  - name: "Create user"
    collection: my-api
    folder: "Users"
    request: "Create User"
    extract:
      createdUserId: "$.id"

teardown:
  - name: "Delete user"
    collection: my-api
    folder: "Users"
    request: "Delete User"
```

- `setup` steps run before `steps`. If any setup step fails, `steps` are skipped entirely.
- `teardown` steps run after `steps`, regardless of whether they passed or failed.
- Teardown failures are logged but **do not affect the exit code** — their purpose is cleanup, not assertions.
- Both `setup` and `teardown` accept the same step types as `steps`.

---

## Adding new tests

### New request

1. Open the collection in the Postman GUI
2. Add the request to the correct folder with test scripts (`pm.test`, `pm.environment.set`)
3. Export and replace the file in `collections/`

### New flow

Create `tests/<category>/name.yml` following the format above:
- `stop_on_failure: true` — for flows where each step depends on the previous one
- `stop_on_failure: false` — for error validation flows where steps are independent
- Add `setup` / `teardown` to ensure the flow leaves no side effects in the environment

### New environment

Duplicate `environments/local.postman_environment.json`, adjust URLs and credentials, and pass the name as the second argument:

```bash
./scripts/run-test.sh auth/login-success.yml staging
./scripts/run-request.sh my-api "OAuth2" "Get Token" staging
```

---

## Project structure

```
kanasha-flow/
├── collections/                  ← endpoint definitions (not executed directly)
│   └── example.postman_collection.json
├── environments/
│   └── example.postman_environment.json
├── tests/                        ← declarative YAML test scenarios
│   └── example/
│       └── get-google.yml
├── reports/                      ← generated with --report (gitignored)
│   └── YYYY-MM-DD_HH-mm_<flow>.[json|html]
├── runner/
│   ├── runner.js                 ← orchestrator (uses Newman internally)
│   └── package.json
├── scripts/
│   ├── run-request.sh            ← run a single request
│   ├── run-test.sh               ← run a full flow
│   ├── run-all-tests.sh          ← run all flows in sequence
│   └── run-all.sh                ← run all services in sequence (calls per-service scripts)
```
