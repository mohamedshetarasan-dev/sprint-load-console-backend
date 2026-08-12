// Sprint Load Console — backend
//
// Pulls User Stories -> child Tasks from Azure DevOps for a set of sprints,
// classifies each task as "dev" or "testing" work (Activity field first, title
// keywords as fallback), applies the effort fallback chain (Completed Work ->
// Original Estimate -> Remaining Work), and returns per-sprint aggregates the
// frontend dashboard can render.
//
// Project / Team / Area Path are no longer fixed in .env — they're selectable
// from the UI. .env only supplies the org URL, the PAT, and optional defaults.
//
// Nothing here ever sends the PAT to the browser — the frontend only ever
// talks to this server, and this server is the only thing that talks to Azure DevOps.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const NodeCache = require('node-cache');

const {
  AZURE_DEVOPS_ORG_URL,
  AZURE_DEVOPS_PAT,
  DEFAULT_PROJECT,
  DEFAULT_TEAM,
  DEFAULT_AREA_PATH,
  SPRINT_ALLOWLIST,
  CACHE_TTL_SECONDS,
  PORT,
} = process.env;

if (!AZURE_DEVOPS_ORG_URL || !AZURE_DEVOPS_PAT) {
  console.error(
    '[startup] Missing required env vars. Copy .env.example to .env and fill in ' +
      'AZURE_DEVOPS_ORG_URL and AZURE_DEVOPS_PAT. (Project/Team/Area Path are now ' +
      'chosen from the UI — DEFAULT_PROJECT/DEFAULT_TEAM/DEFAULT_AREA_PATH are optional.)'
  );
  process.exit(1);
}

const cache = new NodeCache({ stdTTL: Number(CACHE_TTL_SECONDS || 900) });
const app = express();
app.use(cors());
app.use(express.static('public'));

// ---------- Azure DevOps HTTP helpers ----------

function authHeader() {
  const token = Buffer.from(':' + AZURE_DEVOPS_PAT).toString('base64');
  return `Basic ${token}`;
}

async function adoFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Azure DevOps request failed (${res.status}): ${url}\n${body}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ---------- Step 1: discovery — projects, teams, area paths, sprints ----------

async function listProjects() {
  const url = `${AZURE_DEVOPS_ORG_URL}/_apis/projects?api-version=7.1&$top=200`;
  const data = await adoFetch(url);
  return data.value.map((p) => ({ id: p.id, name: p.name }));
}

async function listTeams(project) {
  const url = `${AZURE_DEVOPS_ORG_URL}/_apis/projects/${encodeURIComponent(project)}/teams?api-version=7.1`;
  const data = await adoFetch(url);
  return data.value.map((t) => ({ id: t.id, name: t.name }));
}

async function listAreaPaths(project) {
  const url = `${AZURE_DEVOPS_ORG_URL}/${encodeURIComponent(
    project
  )}/_apis/wit/classificationnodes/areas?$depth=15&api-version=7.1`;
  const root = await adoFetch(url);

  const paths = [];
  function walk(node, prefix) {
    const full = prefix ? `${prefix}\\${node.name}` : node.name;
    paths.push(full);
    (node.children || []).forEach((child) => walk(child, full));
  }
  walk(root, '');
  return paths;
}

async function getTeamIterations(project, team) {
  const teamSeg = encodeURIComponent(team || '');
  const projectSeg = encodeURIComponent(project);
  const url = `${AZURE_DEVOPS_ORG_URL}/${projectSeg}/${teamSeg}/_apis/work/teamsettings/iterations?api-version=7.1`;
  const data = await adoFetch(url);
  return data.value.map((it) => it.name);
}

async function resolveSprintList(project, team) {
  if (SPRINT_ALLOWLIST && SPRINT_ALLOWLIST.trim().length > 0) {
    return SPRINT_ALLOWLIST.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return getTeamIterations(project, team);
}

// ---------- Step 2: WIQL — story -> task hierarchy links for the given sprints ----------

async function getStoryTaskPairs(project, areaPath, sprintNames) {
  const iterationList = sprintNames
    .map((s) => `'${project}\\${s.replace(/'/g, "''")}'`)
    .join(',');

  const wiql = `
    SELECT [System.Id]
    FROM WorkItemLinks
    WHERE
      (
        [Source].[System.TeamProject] = '${project}'
        AND [Source].[System.WorkItemType] = 'User Story'
        AND [Source].[System.State] = 'Closed'
        AND [Source].[System.AreaPath] UNDER '${areaPath}'
        AND [Source].[System.IterationPath] IN (${iterationList})
      )
      AND [System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward'
      AND ( [Target].[System.WorkItemType] = 'Task' )
    MODE (MustContain)
  `;

  const url = `${AZURE_DEVOPS_ORG_URL}/${encodeURIComponent(project)}/_apis/wit/wiql?api-version=7.1`;
  const data = await adoFetch(url, { method: 'POST', body: JSON.stringify({ query: wiql }) });

  const storyIds = new Set();
  const taskIds = new Set();
  const pairs = [];

  for (const rel of data.workItemRelations || []) {
    if (rel.rel === 'System.LinkTypes.Hierarchy-Forward' && rel.source && rel.target) {
      storyIds.add(rel.source.id);
      taskIds.add(rel.target.id);
      pairs.push([rel.source.id, rel.target.id]);
    } else if (!rel.rel && rel.source === null && rel.target) {
      // story with no children still shows up as a root node
      storyIds.add(rel.target.id);
    }
  }

  return { storyIds: [...storyIds], taskIds: [...taskIds], pairs };
}

// ---------- Step 3: batch-fetch work item fields (200-item cap per Azure DevOps) ----------

async function batchGetWorkItems(ids, fields) {
  if (ids.length === 0) return [];
  const chunks = [];
  for (let i = 0; i < ids.length; i += 190) chunks.push(ids.slice(i, i + 190));

  const results = [];
  for (const chunk of chunks) {
    const url = `${AZURE_DEVOPS_ORG_URL}/_apis/wit/workitemsbatch?api-version=7.1`;
    const data = await adoFetch(url, {
      method: 'POST',
      body: JSON.stringify({ ids: chunk, fields }),
    });
    results.push(...data.value);
  }
  return results;
}

// ---------- Step 4: business logic — effort fallback + dev/testing classification ----------

function pickEffort(fields) {
  const completed = fields['Microsoft.VSTS.Scheduling.CompletedWork'];
  const original = fields['Microsoft.VSTS.Scheduling.OriginalEstimate'];
  const remaining = fields['Microsoft.VSTS.Scheduling.RemainingWork'];
  if (completed !== undefined && completed !== null) return completed;
  if (original !== undefined && original !== null) return original;
  if (remaining !== undefined && remaining !== null) return remaining;
  return 0;
}

const TESTING_KEYWORDS = ['test', 'testing', 'qc', 'regression', 'verify', 'execution', 'execute'];
const TESTING_PHRASES = ['user story review', 'review user story'];
const DEV_WORD_RE = /\b(be|backend|dev|fe|frontend)\b/i;

// Azure DevOps' built-in Activity picklist commonly includes values like
// "Development", "Testing", "Design", "Deployment", "Documentation",
// "Requirements", "Code Review". We only care about the two that map
// cleanly onto our dev/testing split — everything else falls through
// to the keyword-based classification below.
function classifyByActivity(activity) {
  if (!activity) return null;
  const a = activity.toLowerCase();
  if (a === 'testing') return 'testing';
  if (a === 'development') return 'dev';
  return null;
}

function classifyTask(title, activity) {
  const byActivity = classifyByActivity(activity);
  if (byActivity) return byActivity;

  const t = (title || '').toLowerCase();
  const isTesting =
    TESTING_KEYWORDS.some((k) => t.includes(k)) || TESTING_PHRASES.some((p) => t.includes(p));
  const isDev = DEV_WORD_RE.test(t);
  if (isTesting) return 'testing'; // testing takes priority when a title matches both
  if (isDev) return 'dev';
  return 'other';
}

// ---------- Step 5: orchestrate + aggregate per sprint ----------

function workItemUrl(project, id) {
  return `${AZURE_DEVOPS_ORG_URL}/${encodeURIComponent(project)}/_workitems/edit/${id}`;
}

function effortSource(fields) {
  if (fields['Microsoft.VSTS.Scheduling.CompletedWork'] != null) return 'Completed Work';
  if (fields['Microsoft.VSTS.Scheduling.OriginalEstimate'] != null) return 'Original Estimate';
  if (fields['Microsoft.VSTS.Scheduling.RemainingWork'] != null) return 'Remaining Work';
  return 'none (defaulted to 0)';
}

async function buildSprintData(project, areaPath, sprintNames) {
  const { storyIds, taskIds, pairs } = await getStoryTaskPairs(project, areaPath, sprintNames);

  const storyItems = await batchGetWorkItems(storyIds, [
    'System.Id',
    'System.Title',
    'System.IterationPath',
    'Microsoft.VSTS.Scheduling.StoryPoints',
  ]);
  const taskItems = await batchGetWorkItems(taskIds, [
    'System.Id',
    'System.Title',
    'Microsoft.VSTS.Common.Activity',
    'Microsoft.VSTS.Scheduling.CompletedWork',
    'Microsoft.VSTS.Scheduling.OriginalEstimate',
    'Microsoft.VSTS.Scheduling.RemainingWork',
  ]);

  const storyMap = new Map();
  for (const item of storyItems) {
    const iterationFull = item.fields['System.IterationPath'] || '';
    const sprintShort = iterationFull.includes('\\')
      ? iterationFull.split('\\').slice(1).join('\\')
      : iterationFull;
    storyMap.set(item.id, {
      sprint: sprintShort,
      title: item.fields['System.Title'] || `Story ${item.id}`,
      storyPoints: item.fields['Microsoft.VSTS.Scheduling.StoryPoints'] || 0,
    });
  }

  const taskMap = new Map();
  for (const item of taskItems) {
    taskMap.set(item.id, {
      title: item.fields['System.Title'] || `Task ${item.id}`,
      activity: item.fields['Microsoft.VSTS.Common.Activity'] || null,
      effort: pickEffort(item.fields),
      effortSource: effortSource(item.fields),
    });
  }

  // seed every requested sprint so the frontend always has a consistent shape
  const bySprintName = new Map(
    sprintNames.map((s) => [
      s,
      {
        sp: 0,
        dev: 0,
        testing: 0,
        other: 0,
        stories: 0,
        details: { dev: [], testing: [], other: [] },
      },
    ])
  );

  for (const [storyId, taskId] of pairs) {
    const story = storyMap.get(storyId);
    if (!story) continue;
    const bucket = bySprintName.get(story.sprint);
    if (!bucket) continue; // story belongs to a sprint outside the requested set

    const task = taskMap.get(taskId);
    if (!task) continue;

    const cat = classifyTask(task.title, task.activity);
    bucket[cat] += task.effort;
    bucket.details[cat].push({
      taskId,
      taskTitle: task.title,
      taskUrl: workItemUrl(project, taskId),
      storyId,
      storyTitle: story.title,
      storyUrl: workItemUrl(project, storyId),
      hours: round1(task.effort),
      effortSource: task.effortSource,
      activity: task.activity,
    });
  }

  // story points + story counts are per-story, not per-task-pair, so add once
  for (const [storyId, story] of storyMap.entries()) {
    const bucket = bySprintName.get(story.sprint);
    if (!bucket) continue;
    bucket.sp += story.storyPoints || 0;
    bucket.stories += 1;
  }

  const out = {};
  for (const [sprint, vals] of bySprintName.entries()) {
    for (const cat of ['dev', 'testing', 'other']) {
      vals.details[cat].sort((a, b) => b.hours - a.hours);
    }
    out[sprint] = {
      sp: round1(vals.sp),
      dev: round1(vals.dev),
      testing: round1(vals.testing),
      other: round1(vals.other),
      stories: vals.stories,
      details: vals.details,
    };
  }
  return out;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

// ---------- Routes ----------

// Discovery endpoints — power the Project / Team / Area Path dropdowns in the UI.

app.get('/api/projects', async (req, res) => {
  try {
    const cacheKey = 'projects';
    let list = cache.get(cacheKey);
    if (!list) {
      list = await listProjects();
      cache.set(cacheKey, list);
    }
    res.json({ projects: list, defaultProject: DEFAULT_PROJECT || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/teams', async (req, res) => {
  try {
    const project = req.query.project;
    if (!project) return res.status(400).json({ error: 'project query param is required' });
    const cacheKey = `teams:${project}`;
    let list = cache.get(cacheKey);
    if (!list) {
      list = await listTeams(project);
      cache.set(cacheKey, list);
    }
    res.json({ teams: list, defaultTeam: DEFAULT_TEAM || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/areas', async (req, res) => {
  try {
    const project = req.query.project;
    if (!project) return res.status(400).json({ error: 'project query param is required' });
    const cacheKey = `areas:${project}`;
    let list = cache.get(cacheKey);
    if (!list) {
      list = await listAreaPaths(project);
      cache.set(cacheKey, list);
    }
    res.json({ areas: list, defaultAreaPath: DEFAULT_AREA_PATH || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sprints', async (req, res) => {
  try {
    const project = req.query.project || DEFAULT_PROJECT;
    const team = req.query.team || DEFAULT_TEAM;
    if (!project) return res.status(400).json({ error: 'project query param is required' });

    const cacheKey = `sprint-list:${project}:${team || ''}`;
    let list = cache.get(cacheKey);
    if (!list) {
      list = await resolveSprintList(project, team);
      cache.set(cacheKey, list);
    }
    res.json({ sprints: list });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sprint-data', async (req, res) => {
  try {
    const project = req.query.project || DEFAULT_PROJECT;
    const team = req.query.team || DEFAULT_TEAM;
    const areaPath = req.query.areaPath || DEFAULT_AREA_PATH;

    if (!project) return res.status(400).json({ error: 'project query param is required' });
    if (!areaPath) return res.status(400).json({ error: 'areaPath query param is required' });

    const requested = req.query.sprints
      ? String(req.query.sprints).split(',').map((s) => s.trim()).filter(Boolean)
      : await resolveSprintList(project, team);

    const cacheKey = `sprint-data:${project}:${areaPath}:` + requested.slice().sort().join('|');
    const cached = cache.get(cacheKey);
    if (cached) {
      return res.json({ data: cached, cached: true });
    }

    const data = await buildSprintData(project, areaPath, requested);
    cache.set(cacheKey, data);
    res.json({ data, cached: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/refresh', (req, res) => {
  cache.flushAll();
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    defaultProject: DEFAULT_PROJECT || null,
    defaultTeam: DEFAULT_TEAM || null,
    defaultAreaPath: DEFAULT_AREA_PATH || null,
  });
});

const port = Number(PORT || 8787);
app.listen(port, () => {
  console.log(`Sprint Load Console backend listening on http://localhost:${port}`);
  console.log(`Dashboard (if you copied index.html into /public): http://localhost:${port}`);
});
