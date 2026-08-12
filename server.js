// Sprint Load Console — backend
//
// Pulls User Stories -> child Tasks from Azure DevOps for a set of sprints,
// classifies each task as "dev" or "testing" work by title keyword,
// applies the effort fallback chain (Completed Work -> Original Estimate -> Remaining Work),
// and returns per-sprint aggregates the frontend dashboard can render.
//
// Nothing here ever sends the PAT to the browser — the frontend only ever
// talks to this server, and this server is the only thing that talks to Azure DevOps.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const NodeCache = require('node-cache');

const {
  AZURE_DEVOPS_ORG_URL,
  AZURE_DEVOPS_PROJECT,
  AZURE_DEVOPS_AREA_PATH,
  AZURE_DEVOPS_TEAM,
  AZURE_DEVOPS_PAT,
  SPRINT_ALLOWLIST,
  CACHE_TTL_SECONDS,
  PORT,
} = process.env;

if (!AZURE_DEVOPS_ORG_URL || !AZURE_DEVOPS_PROJECT || !AZURE_DEVOPS_PAT) {
  console.error(
    '[startup] Missing required env vars. Copy .env.example to .env and fill in ' +
      'AZURE_DEVOPS_ORG_URL, AZURE_DEVOPS_PROJECT, and AZURE_DEVOPS_PAT.'
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

// ---------- Step 1: discover sprints (if no allowlist given) ----------

async function getTeamIterations() {
  const team = encodeURIComponent(AZURE_DEVOPS_TEAM || '');
  const project = encodeURIComponent(AZURE_DEVOPS_PROJECT);
  const url = `${AZURE_DEVOPS_ORG_URL}/${project}/${team}/_apis/work/teamsettings/iterations?api-version=7.1`;
  const data = await adoFetch(url);
  return data.value.map((it) => it.name);
}

async function resolveSprintList() {
  if (SPRINT_ALLOWLIST && SPRINT_ALLOWLIST.trim().length > 0) {
    return SPRINT_ALLOWLIST.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return getTeamIterations();
}

// ---------- Step 2: WIQL — story -> task hierarchy links for the given sprints ----------

async function getStoryTaskPairs(sprintNames) {
  const project = AZURE_DEVOPS_PROJECT;
  const areaPath = AZURE_DEVOPS_AREA_PATH;
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

function workItemUrl(id) {
  return `${AZURE_DEVOPS_ORG_URL}/${encodeURIComponent(AZURE_DEVOPS_PROJECT)}/_workitems/edit/${id}`;
}

function effortSource(fields) {
  if (fields['Microsoft.VSTS.Scheduling.CompletedWork'] != null) return 'Completed Work';
  if (fields['Microsoft.VSTS.Scheduling.OriginalEstimate'] != null) return 'Original Estimate';
  if (fields['Microsoft.VSTS.Scheduling.RemainingWork'] != null) return 'Remaining Work';
  return 'none (defaulted to 0)';
}

async function buildSprintData(sprintNames) {
  const project = AZURE_DEVOPS_PROJECT;
  const { storyIds, taskIds, pairs } = await getStoryTaskPairs(sprintNames);

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
      taskUrl: workItemUrl(taskId),
      storyId,
      storyTitle: story.title,
      storyUrl: workItemUrl(storyId),
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

app.get('/api/sprints', async (req, res) => {
  try {
    const key = 'sprint-list';
    let list = cache.get(key);
    if (!list) {
      list = await resolveSprintList();
      cache.set(key, list);
    }
    res.json({ sprints: list });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sprint-data', async (req, res) => {
  try {
    const requested = req.query.sprints
      ? String(req.query.sprints).split(',').map((s) => s.trim()).filter(Boolean)
      : await resolveSprintList();

    const cacheKey = 'sprint-data:' + requested.slice().sort().join('|');
    const cached = cache.get(cacheKey);
    if (cached) {
      return res.json({ data: cached, cached: true });
    }

    const data = await buildSprintData(requested);
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
  res.json({ ok: true, project: AZURE_DEVOPS_PROJECT, areaPath: AZURE_DEVOPS_AREA_PATH });
});

const port = Number(PORT || 8787);
app.listen(port, () => {
  console.log(`Sprint Load Console backend listening on http://localhost:${port}`);
  console.log(`Dashboard (if you copied index.html into /public): http://localhost:${port}`);
});
