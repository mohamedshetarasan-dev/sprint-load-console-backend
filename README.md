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
  pre-select the Scope dropdowns on first load (and are the fallback if a request
  to `/api/sprint-data` omits `project`/`team`/`areaPath`). **Project, Team, and
  Area Path are actually chosen from the dashboard itself** via the Scope picker —
  leave any of these blank to start with nothing pre-selected and pick manually.
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
   - Looks up each requested sprint's real full iteration path from the team's
     iteration list first — sprints aren't always a direct child of the project
     (e.g. `Leasing\Revamp Iterations\Lease Revamp Sprint 1`), so this can't be
     guessed as `${project}\${sprintName}`; doing so throws Azure DevOps' TF51011
     "iteration path does not exist" error as soon as a team nests its sprints
     under a folder.
   - Runs a WIQL `WorkItemLinks` query to find every **Closed** User Story → Task
     hierarchy link for the requested sprints (by their real paths) under the
     chosen area path.
   - Batch-fetches Story Points for every story and Activity / Completed Work /
     Original Estimate / Remaining Work for every task (200 IDs per call, chunked
     automatically).
   - Classifies each task as `dev` or `testing` using three layers, in order, stopping
     at the first one that gives an answer:
     1. **Capacity tab** — the assignee's Activity (`Development` / `Testing`) on the
        Sprints > Capacity page for that iteration and team. This is checked first
        because it's a per-person, per-sprint statement of who's on the dev team vs.
        the testing team that sprint, and should win even if the task itself doesn't
        say anything. If someone has both Development and Testing rows in Capacity,
        that's treated as ambiguous and falls through to the next layer.
     2. **Activity field** on the task itself (`Development` / `Testing`), for tasks
        assigned to someone not in the Capacity tab (or with no capacity set that
        sprint).
     3. **Title keyword match**, as a last resort:
        - **testing**: title contains `test`, `testing`, `qc`, `regression`,
          `verify`, `execution`, `execute`, or the phrase `user story review`
        - **dev**: title contains the standalone word `BE`, `backend`, `dev`,
          `FE`, or `frontend`
        - anything matching neither falls into `other`
   - Effort per task = Completed Work, else Original Estimate, else Remaining Work.
   - Each sprint's result includes a `classifiedBy` tally (`capacity` / `activity` /
     `title-keyword` / `unclassified` counts) and each task-level detail row carries
     `assignedTo` and `classifiedBy` so you can see exactly which layer decided it —
     the dashboard's drill-down shows both.
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

The Capacity-tab layer (checked first, ahead of the two rules above) works off the
**assignee**, not the task, and requires no config — it reads whatever the team already
set up on Sprints > Capacity for that iteration. It matches the task's Assigned To
against each capacity row by uniqueName (email), falling back to displayName. Notes:

- Requires the same PAT scope already in use (Work Items: Read) plus visibility into
  team settings, which that scope already covers.
- A team member with capacity rows for *both* Development and Testing in the same
  sprint is treated as ambiguous, and tasks assigned to them fall through to the
  Activity-field / title-keyword layers instead.
- If a sprint has no capacity configured at all (e.g. an older sprint no one set up
  capacity for), that sprint just falls straight through to the existing two layers —
  nothing breaks.
- Azure DevOps returns Assigned To as a plain `"Display Name <unique.name@x.com>"`
  string when tasks are fetched via `workitemsbatch` with an explicit `fields` list
  (as this server does), not as the `{ id, displayName, uniqueName }` object you get
  from an `$expand`-ed single work item. `parseAssignedTo()` in `server.js` handles
  both shapes — this was the actual bug behind capacity-tab matches silently missing
  for every task at first (e.g. work item 338464), since the object fields were all
  `undefined` on the string shape.

### Two capacity data sources — and why

Azure DevOps' public, documented capacity endpoint
(`_apis/work/teamsettings/iterations/{id}/capacities`) has a confirmed gap: for some
team members the row is just missing from the response, even though Sprints >
Capacity in the browser clearly shows them with an Activity set (verified directly
against this org — one sprint returned 8 people from this endpoint while the actual
Capacity page showed 12, work item 336009's assignee among the missing 4). Azure
DevOps' own web client doesn't hit this endpoint to render that page at all — it
calls an internal data-provider endpoint
(`_apis/Contribution/HierarchyQuery`, contribution
`ms.vss-work-web.sprints-hub-capacity-data-provider`) that returns the complete list.

`getSprintCapacityMap()` in `server.js` now tries that same internal endpoint first
(`getSprintCapacityMapRich`) and only falls back to the public one
(`getSprintCapacityMapBasic`) if it fails for any reason — wrong response shape, the
endpoint being retired, network error, etc. Since that internal endpoint isn't a
documented public contract, it's the one part of this classification chain that
could break on some future Azure DevOps update; if it does, everything keeps working
exactly as it did before this was added (same fallback behavior, same known gap).
Each sprint in `/api/sprint-data`'s response carries a `capacitySource` field
(`'rich'` or `'rich-unavailable'`) so this is visible instead of silent — the
dashboard shows a warning toast for any loaded sprint where the fallback kicked in.
When that happens, a `capacityError` field on the sprint carries the actual reason
(`rich`/`basic` error messages) instead of just the fact that it fell back.

In this org, the rich lookup always fails with a `401` — Azure DevOps rejects PAT
(Basic auth) credentials for `_apis/Contribution/HierarchyQuery`, since it's really
meant for the signed-in web client's session auth, not automation. That's expected
and already handled by the fallback.

**Bug found and fixed while verifying this**: `getSprintCapacityMapBasic` only ever
read `data.value` from the public capacities response, per Azure DevOps' documented
schema (`{ count, value: [...] }`). But the live response from this org at
`api-version=7.1` actually wraps the list in `data.teamMembers` instead — confirmed
by dumping the raw response body. Reading only `data.value` meant it silently parsed
to an empty array *every time, for every team*, so the capacity layer never actually
classified a single task — it always fell straight through to the Activity/title
layers no matter what was set up in Capacity. This is why work item 333356 (Aya Abd
Elhameed, Development capacity) showed as `other`: the classifier never saw any
capacity data at all, rich or basic. Fixed by reading `data.value || data.teamMembers`
so it works with either shape.

## Team roster icon

Each sprint row in the breakdown table has a 👥 icon at the start of the row. Clicking
it opens the same drill-down panel used for task detail, but showing who had Capacity
set for that sprint, grouped by Activity (Development / Testing / etc.) with their
capacity per day — pulled from the same rich/basic capacity lookup described above
(`/api/sprint-data`'s `roster` field per sprint). If a sprint has no capacity data at
all, the panel just says so instead of erroring. The Total row has no icon since a
roster doesn't meaningfully aggregate across multiple sprints.

## Deploying somewhere other than your laptop

This is a stateless Express app with an in-memory cache, so it runs fine on any
Node host (a small VM, Render, Railway, etc.) — just set the same environment
variables there. If you deploy it, put it behind your company's normal auth/VPN
rather than exposing it publicly, since it holds a PAT with read access to your
Azure DevOps org.
