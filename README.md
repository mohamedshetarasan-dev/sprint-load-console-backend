# Sprint Load Console — backend + dashboard

This is the full stack for the Motor ShortTerm sprint dashboard:

- **`server.js`** — a small Node/Express server that talks to Azure DevOps on your behalf
  (using your PAT, kept server-side only), runs the same WIQL + batch-fetch + classification
  logic used earlier in chat, and exposes it as a JSON API.
- **`public/index.html`** — the dashboard UI. It calls the backend on load; if the backend
  is unreachable it falls back to a static snapshot so it's never blank.

Your Azure DevOps PAT never reaches the browser — only this server sees it.

## 1. Install

Requires Node.js 18+ (for built-in `fetch`).

```bash
cd sprint-backend
npm install
```

## 2. Configure

```bash
cp .env.example .env
```

Edit `.env`:

- `AZURE_DEVOPS_ORG_URL` — e.g. `https://tameeni.visualstudio.com`
- `AZURE_DEVOPS_PAT` — generate one at `https://<org>.visualstudio.com/_usersSettings/tokens`
  with **Work Items: Read** scope (Read & Write not needed since this only reads data)
- `DEFAULT_PROJECT` / `DEFAULT_TEAM` / `DEFAULT_AREA_PATH` — optional. These just
  pre-select the dropdowns in the UI on first load; **Project, Team, and Area Path are
  chosen from the dashboard itself**, not fixed in `.env`. Leave any of them blank to
  start with nothing pre-selected.
- `SPRINT_ALLOWLIST` — comma-separated sprint names to show. Leave blank to auto-discover
  every iteration configured for the selected team instead.
- `CACHE_TTL_SECONDS` — how long to cache Azure DevOps results before re-querying
  (default 900s / 15 min — Azure DevOps rate-limits aggressively, so don't set this too low)

## 3. Run

```bash
npm start
```

Then open **http://localhost:8787**. On first load the sidebar's **Scope** section pulls
every project your PAT can see, then cascades to that project's teams and area paths.
Pick Project → Team → Area Path and hit **Apply & reload sprints**. Your last selection
is remembered in the browser (`localStorage`) so it's still there next time you open the
dashboard.

## How it works

1. `GET /api/projects` — lists every project the PAT has access to.
2. `GET /api/teams?project=X` and `GET /api/areas?project=X` — once a project is picked,
   these populate the Team and Area Path dropdowns (area paths are flattened from Azure
   DevOps's classification-node tree).
3. `GET /api/sprint-data?project=X&team=Y&areaPath=Z&sprints=...` (sprints optional —
   defaults to every iteration configured for the team) does the real work:
   - Runs a WIQL `WorkItemLinks` query to find every **Closed** User Story → Task
     hierarchy link for the requested sprints under the chosen area path.
   - Batch-fetches Story Points for every story and Activity / Completed Work /
     Original Estimate / Remaining Work for every task (200 IDs per call, chunked
     automatically).
   - Classifies each task as `dev` or `testing`, checking the **Activity** field first
     (`Development` / `Testing`) and falling back to title keywords when Activity isn't
     set:
     - **testing** (fallback): title contains `test`, `testing`, `qc`, `regression`,
       `verify`, `execution`, `execute`, or the phrase `user story review`
     - **dev** (fallback): title contains the standalone word `BE`, `backend`, `dev`,
       `FE`, or `frontend`
     - anything matching neither falls into `other`
   - Effort per task = Completed Work, else Original Estimate, else Remaining Work.
4. Results are cached in memory per (project, area path, sprint-set) for
   `CACHE_TTL_SECONDS` to avoid hammering Azure DevOps on every page load.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/projects` | All projects visible to the PAT |
| GET | `/api/teams?project=X` | Teams within a project |
| GET | `/api/areas?project=X` | Flattened area-path tree for a project |
| GET | `/api/sprints?project=X&team=Y` | Sprint names configured for a team |
| GET | `/api/sprint-data?project=X&team=Y&areaPath=Z&sprints=...` | Aggregated per-sprint data (dev/testing/other hours, story points, story count, drill-down detail) |
| POST | `/api/refresh` | Clears the cache so the next request re-pulls from Azure DevOps |
| GET | `/api/health` | Quick check that the server started with valid config |

## Adjusting the classification rules

The keyword lists live in `server.js`:

```js
const TESTING_KEYWORDS = ['test', 'testing', 'qc', 'regression', 'verify', 'execution', 'execute'];
const TESTING_PHRASES = ['user story review', 'review user story'];
const DEV_WORD_RE = /\b(be|backend|dev|fe|frontend)\b/i;
```

Edit these and restart the server (or just refresh — no rebuild step) to retune what
counts as dev vs. testing work.

## Deploying somewhere other than your laptop

This is a stateless Express app with an in-memory cache, so it runs fine on any
Node host (a small VM, Render, Railway, etc.) — just set the same environment
variables there. If you deploy it, put it behind your company's normal auth/VPN
rather than exposing it publicly, since it holds a PAT with read access to your
Azure DevOps org.
