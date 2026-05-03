# kanasha-flow

A YAML-driven API test runner built on top of Postman collections. Chain requests, persist state across flows, and mix automated and interactive steps in a single tool.

Postman **collections** define the available endpoints. The **runner** executes them, chains variables, and orchestrates scenarios.

> Project files (`collections/`, `environments/`, `tests/`) are gitignored. Files prefixed with `example` are the exception — copy, rename, and adapt them as your starting point.

## Why not plain Newman?

If your tests are stateless — each run starts from scratch — Newman with a shell script is probably enough.

kanasha-flow is built for a specific problem: **tests that have dependencies across separate runs**. The state persisted in `.env-state.json` is what makes it useful:

- Set up your application on Monday, run auth tests on Tuesday — the IDs are still there
- A login flow saves the token; the next flow uses it without logging in again
- A human-input step pauses and waits for a code received by email or SMS — something Newman can't do at all

| | Plain Newman | kanasha-flow |
|---|---|---|
| Persist variables across separate runs | ✗ | ✓ via `.env-state.json` |
| Chain flows with shared state | ✗ | ✓ |
| Pause and prompt for user input (e.g. email/SMS code) | ✗ | ✓ via `human-input` |

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
                    │  1. load environment             │
                    │  2. merge with .env-state.json   │
                    │  3. execute each step in order   │
                    │     └─ call Newman per request   │
                    │     └─ extract variables         │
                    │     └─ pause for human-input     │
                    │  4. save updated state           │
                    │  5. generate report (--report)   │
                    └─────────────────────────────────┘
                                    │
                          .env-state.json
                        (persists between runs)
```

Each run reads the previous state and writes the new one — so a token obtained in one flow is available in the next, even if they run at different times.

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

# Automated tests only + report
./scripts/run-all-tests.sh local --auto --report
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

Flags are combinable and work on both `run-test.sh` and `run-all-tests.sh`:

```bash
# Automated tests only
./scripts/run-all-tests.sh local --auto

# With report
./scripts/run-test.sh auth/login-success.yml local --report

# Combined
./scripts/run-all-tests.sh local --auto --report
```

When `--auto` is used on a flow with `human-input` steps, the runner skips it and exits with code 0 (not counted as a failure):

```
⏭  Skipping "onboarding/full-email-flow.yml" — contains human-input steps (--auto)
```

Reports are saved in `reports/` with a timestamp in the filename (`YYYY-MM-DDTHH-mm_<flow>.json|html`) and are gitignored.

### Manual state

Set variables directly into the state without running a request.

```bash
./scripts/set-var.sh userId "258746a0-6caf-4bdd-8d13-743a42e3884c"
./scripts/set-var.sh userEmail "user@example.com"
./scripts/set-var.sh --get               # view full state
./scripts/set-var.sh --get userId        # view a single variable
```

### Ad-hoc scenario

Any combination of calls is a valid test:

```bash
./scripts/run-request.sh my-api "OAuth2" "Get Token"
./scripts/set-var.sh targetUserId "uuid-here"
./scripts/run-request.sh my-api "Roles" "Assign Role"
./scripts/run-request.sh my-api "Roles" "List User Roles"
```

---

## Variable chaining

State is built in layers — each run reads and writes to the same `.env-state.json`:

1. `environments/local.postman_environment.json` — base values (URLs, credentials, etc.)
2. `.env-state.json` — state persisted from previous runs
3. `pm.environment.set()` in collection test scripts — automatic after each request
4. `extract` field in YAML — manual JSONPath extraction
5. `human-input` steps — value typed by the user in the terminal
6. `set-var.sh` — manual injection of any variable

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
```

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
│   └── set-var.sh                ← manage state manually
└── .env-state.json               ← state persisted between runs (gitignored)
```
