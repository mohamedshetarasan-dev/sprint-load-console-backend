// Sprint Load Console — backend
//
// Pulls User Stories -> child Tasks from Azure DevOps for a set of sprints,
// classifies each task as "dev" or "testing" work using a three-layer chain
// (Capacity tab activity for the assignee -> task's own Activity field ->
// title keyword match), applies the effort fallback chain (Completed Work ->
// Original Estimate -> Remaining Work), and returns per-sprint aggregates the
// frontend dashboard can render.
//
// Project / Team / Area Path are NOT fixed — the dashboard's Scope picker
// calls /api/projects, /api/teams, /api/areas to populate its dropdowns, then
// passes the chosen project/team/areaPath as query params to /api/sprint-data.
// DEFAULT_PROJECT / DEFAULT_TEAM / DEFAULT_AREA_PATH in .env are just used to
// pre-select those dropdowns (and as a fallback if a request omits them).
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
  DEFAULT_AREA_PATH,
  DEFAULT_TEAM,
  SPRINT_ALLOWLIST,
  CACHE_TTL_SECONDS,
  PORT,
} = process.env;

if (!AZURE_DEVOPS_ORG_URL || !AZURE_DEVOPS_PAT) {
  console.error(
    '[startup] Missing required env vars. Check your .env has values for ' +
      'AZURE_DEVOPS_ORG_URL and AZURE_DEVOPS_PAT (copy .env.example to .env if you haven\'t already).'
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

// Azure DevOps' work/* APIs accept an optional {team} path segment; when it's
// omitted, Azure DevOps falls back to the project's default team on its own.
// That's what lets "Team" stay optional in the Scope picker.
function teamSegment(team) {
  return team ? encodeURIComponent(team) + '/' : '';
}

// ---------- Scope discovery: projects / teams / area paths ----------

async function listProjects() {
  const url = `${AZURE_DEVOPS_ORG_URL}/_apis/projects?api-version=7.1&$top=1000`;
  const data = await adoFetch(url);
  return (data.value || []).map((p) => ({ id: p.id, name: p.name }));
}

async function listTeams(project) {
  const url = `${AZURE_DEVOPS_ORG_URL}/_apis/projects/${encodeURIComponent(project)}/teams?api-version=7.1&$top=1000`;
  const data = await adoFetch(url);
  return (data.value || []).map((t) => ({ id: t.id, name: t.name }));
}

// Flattens Azure DevOps' area-path classification-node tree into full
// "Project\Area\SubArea" strings, matching the format System.AreaPath uses.
function flattenAreaNode(node, parentPath) {
  const path = parentPath ? `${parentPath}\\${node.name}` : node.name;
  let paths = [path];
  for (const child of node.children || []) {
    paths = paths.concat(flattenAreaNode(child, path));
  }
  return paths;
}

async function listAreaPaths(project) {
  const url = `${AZURE_DEVOPS_ORG_URL}/${encodeURIComponent(
    project
  )}/_apis/wit/classificationnodes/areas?$depth=20&api-version=7.1`;
  const data = await adoFetch(url);
  return flattenAreaNode(data, '');
}

// ---------- Step 1: discover sprints (if no allowlist given) ----------

async function getTeamIterationsFull(project, team) {
  const url = `${AZURE_DEVOPS_ORG_URL}/${encodeURIComponent(project)}/${teamSegment(
    team
  )}_apis/work/teamsettings/iterations?api-version=7.1`;
  const data = await adoFetch(url);
  return data.value; // [{ id, name, path, attributes }, ...] — id is needed for the capacities endpoint
}

async function resolveSprintList(project, team) {
  if (SPRINT_ALLOWLIST && SPRINT_ALLOWLIST.trim().length > 0) {
    return SPRINT_ALLOWLIST.split(',').map((s) => s.trim()).filter(Boolean);
  }
  const iterations = await getTeamIterationsFull(project, team);
  return iterations.map((it) => it.name);
}

// ---------- Step 2: WIQL — story -> task hierarchy links for the given sprints ----------

// iterationPaths must be full relative paths as Azure DevOps reports them
// (e.g. "Leasing\Revamp Iterations\Lease Revamp Sprint 1"), not just the sprint's
// leaf name — sprints aren't always a direct child of the project, and gluing
// "${project}\${sprintName}" together breaks with a TF51011 "iteration path does
// not exist" error as soon as a sprint lives under an intermediate node.
async function getStoryTaskPairs(project, areaPath, iterationPaths) {
  const iterationList = iterationPaths.map((p) => `'${p.replace(/'/g, "''")}'`).join(',');

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

// ---------- Layer 1: Capacity tab — who's on the dev team vs. testing team ----------
//
// Sprints > Capacity is where each team member is given an Activity
// (Development, Testing, Design, Deployment, Documentation, Requirements, ...)
// for that specific iteration. That's a per-person, per-sprint statement of
// "this person is testing team / dev team right now", which is a stronger
// signal than anything on the task itself — someone set up as Testing in
// Capacity should have their work count as testing effort even if a task's
// Activity field was left blank or its title doesn't scream "test". So this
// is checked first; the Activity field and title-keyword layers below only
// kick in when the assignee isn't in the Capacity tab (or their capacity
// activity doesn't map cleanly to dev/testing).
//
// A person can have more than one activity row in Capacity (e.g. split
// between Development and Testing). If both dev and testing are present
// we treat it as ambiguous and fall through rather than guess.
function pickPrimaryCapacityActivity(activities) {
  if (!activities || activities.length === 0) return null;
  const withCapacity = activities.filter((a) => (a.capacityPerDay || 0) > 0);
  const candidates = withCapacity.length > 0 ? withCapacity : activities;
  const hasTesting = candidates.some((a) => (a.name || '').toLowerCase() === 'testing');
  const hasDev = candidates.some((a) => (a.name || '').toLowerCase() === 'development');
  if (hasTesting && hasDev) return null;
  if (hasTesting) return 'testing';
  if (hasDev) return 'dev';
  return null;
}

// Turns a capacity entry's identity info into the same three lookup keys used
// everywhere else (id / uniqueName / displayName), regardless of which of the
// two capacity sources below produced it.
function addCapacityMapEntry(map, member, activityType) {
  if (!activityType || !member) return;
  if (member.id) map.set('id:' + String(member.id).trim().toLowerCase(), activityType);
  if (member.uniqueName) map.set(String(member.uniqueName).trim().toLowerCase(), activityType);
  if (member.displayName) map.set('name:' + String(member.displayName).trim().toLowerCase(), activityType);
}

// A clean, display-ready roster entry — one per person, with their raw
// Capacity-tab activities (not collapsed to just dev/testing, so someone set
// up as Design or Documentation still shows up honestly instead of vanishing).
// Used for the "who's on this sprint" icon in the dashboard, separate from the
// dev/testing lookup map above.
function rosterEntry(member, activities) {
  if (!member || !member.displayName) return null;
  return {
    displayName: member.displayName,
    activities: (activities || []).map((a) => ({
      name: a.name || 'Unknown',
      capacityPerDay: a.capacityPerDay || 0,
    })),
  };
}

// ---------- Capacity source A (basic): the public REST capacities endpoint ----------
//
// This is the officially documented endpoint, but Azure DevOps has a confirmed
// gap here: for some team members the row is simply missing from this response,
// even though Sprints > Capacity in the browser clearly shows them with an
// Activity set (verified directly against the raw API for this org — e.g. Sprint
// 1.Q1.26 / Leasing Team returns 8 people here while the UI shows 12). This is
// kept as the fallback for when the richer lookup below isn't available.
async function getSprintCapacityMapBasic(project, team, iterationId) {
  const map = new Map();
  const roster = [];
  if (!iterationId) return { map, roster };
  const url = `${AZURE_DEVOPS_ORG_URL}/${encodeURIComponent(project)}/${teamSegment(
    team
  )}_apis/work/teamsettings/iterations/${iterationId}/capacities?api-version=7.1`;
  let data;
  try {
    data = await adoFetch(url);
  } catch (err) {
    // No capacity configured for this team/iteration — don't fail the whole
    // request, just fall through to the Activity/title layers for this sprint.
    console.warn(`[capacity] couldn't load capacities for iteration ${iterationId}: ${err.message}`);
    return { map, roster, error: err.message };
  }
  // Azure DevOps' documented schema for this endpoint wraps the list in
  // `value` (confirmed on api-version 6.0's docs), but the live response at
  // api-version=7.1 actually comes back as `teamMembers` instead — verified
  // directly against this org's raw response body. Reading only `data.value`
  // silently returned an empty array every time, on every team, regardless of
  // whether capacity was actually configured — the real cause behind capacity
  // classification never applying (e.g. work item 333356). Check both shapes
  // so this keeps working if Azure DevOps reverts or changes it again.
  const entries = data.value || data.teamMembers || [];
  const rawCount = entries.length;
  for (const entry of entries) {
    addCapacityMapEntry(map, entry.teamMember, pickPrimaryCapacityActivity(entry.activities));
    const person = rosterEntry(entry.teamMember, entry.activities);
    if (person) roster.push(person);
  }
  // The public endpoint can return 200 with a *shorter* list than what the
  // Capacity tab UI actually shows (the whole reason the rich lookup above is
  // tried first) — surface that distinction instead of just "it worked".
  return {
    map,
    roster,
    error: rawCount === 0 ? `basic endpoint returned 0 capacity rows for iteration ${iterationId}` : null,
  };
}

// ---------- Capacity source B (rich): the same internal data provider the ----------
// ---------- Sprints > Capacity page itself calls ----------
//
// Azure DevOps' web client doesn't actually read the public capacities REST API
// to render that page — it calls the generic "HierarchyQuery" data-provider
// endpoint for the contribution "ms.vss-work-web.sprints-hub-capacity-data-provider",
// which returns the complete list (confirmed against the same org/sprint: 12
// people here vs. 8 from the public endpoint above). This isn't a documented
// public contract — it's the same mechanism ADO's own UI uses internally, so it
// could change without notice, which is why every caller of this function must
// be ready to fall back to getSprintCapacityMapBasic.
async function getSprintCapacityMapRich(project, team, sprintName) {
  const map = new Map();
  const roster = [];
  const sourcePageUrl = `${AZURE_DEVOPS_ORG_URL}/${encodeURIComponent(project)}/_sprints/capacity/${encodeURIComponent(
    team
  )}/${encodeURIComponent(project)}/${encodeURIComponent(sprintName)}`;
  const url = `${AZURE_DEVOPS_ORG_URL}/_apis/Contribution/HierarchyQuery?api-version=5.0-preview.1`;
  const body = {
    contributionIds: ['ms.vss-work-web.sprints-hub-capacity-data-provider'],
    dataProviderContext: {
      properties: {
        sourcePage: {
          url: sourcePageUrl,
          routeId: 'ms.vss-work-web.new-sprints-content-route',
          routeValues: {
            project,
            pivot: 'capacity',
            teamName: team,
            iteration: `${project}/${sprintName}`,
          },
        },
      },
    },
  };
  const data = await adoFetch(url, { method: 'POST', body: JSON.stringify(body) });
  const providerData = data && data.dataProviders && data.dataProviders['ms.vss-work-web.sprints-hub-capacity-data-provider'];
  if (!providerData) {
    // Surface Azure DevOps' own explanation when it gives one (e.g.
    // TeamNotFoundException) instead of just "missing from response" —
    // makes it obvious in logs/toast why the rich lookup didn't work.
    const exception =
      data && data.dataProviderExceptions && data.dataProviderExceptions['ms.vss-work-web.sprints-hub-capacity-data-provider'];
    throw new Error(
      exception
        ? `${exception.exceptionType || 'error'}: ${exception.message}`
        : 'capacity data provider missing from HierarchyQuery response'
    );
  }
  for (const entry of providerData.userCapacities || []) {
    // teamMemberIdentityRef has the clean displayName ("Hassan Ramadan Abdelrahman");
    // teamMember here embeds the email in the displayName itself ("Name <email>"),
    // which is why we prefer the identity ref when both are present.
    const member = entry.teamMemberIdentityRef || entry.teamMember;
    addCapacityMapEntry(map, member, pickPrimaryCapacityActivity(entry.activities));
    const person = rosterEntry(member, entry.activities);
    if (person) roster.push(person);
  }
  return { map, roster };
}

// Tries the rich lookup first (needs a team + sprint name to build the page
// context it requires); on any failure — or if we don't have enough info to
// even attempt it — falls back to the basic endpoint. `source` on the result
// tells the caller which one actually served the data, so the frontend can
// flag sprints where we're stuck with the known-incomplete fallback.
async function getSprintCapacityMap(project, team, iterationId, sprintName) {
  let richError = null;
  if (team && sprintName) {
    try {
      const { map, roster } = await getSprintCapacityMapRich(project, team, sprintName);
      return { map, roster, source: 'rich' };
    } catch (err) {
      richError = err.message;
      console.warn(
        `[capacity] rich lookup failed for "${sprintName}", falling back to the basic endpoint (may be missing some people): ${err.message}`
      );
    }
  } else {
    richError = `rich lookup skipped (team=${team || '∅'}, sprintName=${sprintName || '∅'})`;
  }
  if (!iterationId) {
    console.warn(
      `[capacity] no iteration id resolved for "${sprintName}" / team "${team}" — this team's iteration list didn't contain that sprint name, so the basic endpoint can't be called either.`
    );
  }
  const { map, roster, error: basicError } = await getSprintCapacityMapBasic(project, team, iterationId);
  return {
    map,
    roster,
    source: 'rich-unavailable',
    richError,
    basicError: basicError || (!iterationId ? 'no iteration id resolved for this sprint/team' : null),
  };
}

// AssignedTo comes back in two different shapes depending on how a work item is
// fetched from Azure DevOps: a full IdentityRef object ({ id, displayName,
// uniqueName, ... }) when a work item is fetched with $expand, but a plain
// "Display Name <unique.name@x.com>" STRING when fetched via workitemsbatch with
// an explicit `fields` list (which is what this server uses for tasks). Assuming
// it was always an object silently broke every capacity-based match — the id and
// uniqueName just came back undefined — so tasks fell straight through to the
// Activity field / title-keyword layers instead. Handle both shapes here.
function parseAssignedTo(field) {
  if (!field) return null;
  if (typeof field === 'object') {
    return {
      id: field.id || null,
      displayName: field.displayName || null,
      uniqueName: field.uniqueName || null,
    };
  }
  if (typeof field === 'string') {
    const match = field.match(/^(.*?)\s*<([^>]+)>\s*$/);
    if (match) {
      return { id: null, displayName: match[1].trim(), uniqueName: match[2].trim() };
    }
    return { id: null, displayName: field.trim(), uniqueName: null };
  }
  return null;
}

function classifyByCapacity(assignee, capacityMap) {
  if (!assignee || !capacityMap || capacityMap.size === 0) return null;

  if (assignee.id) {
    const idKey = 'id:' + String(assignee.id).trim().toLowerCase();
    if (capacityMap.has(idKey)) return capacityMap.get(idKey);
  }

  const uniqueKey = (assignee.uniqueName || '').trim().toLowerCase();
  if (uniqueKey && capacityMap.has(uniqueKey)) return capacityMap.get(uniqueKey);

  const nameKey = 'name:' + (assignee.displayName || '').trim().toLowerCase();
  return capacityMap.get(nameKey) || null;
}

// ---------- Layer 2: the task's own Activity field ----------
//
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

// ---------- Layer 3: title keyword match (last resort) ----------

function classifyTask(title, activity, assignee, capacityMap) {
  const byCapacity = classifyByCapacity(assignee, capacityMap);
  if (byCapacity) return { category: byCapacity, source: 'capacity' };

  const byActivity = classifyByActivity(activity);
  if (byActivity) return { category: byActivity, source: 'activity' };

  const t = (title || '').toLowerCase();
  const isTesting =
    TESTING_KEYWORDS.some((k) => t.includes(k)) || TESTING_PHRASES.some((p) => t.includes(p));
  const isDev = DEV_WORD_RE.test(t);
  if (isTesting) return { category: 'testing', source: 'title-keyword' }; // testing takes priority when a title matches both
  if (isDev) return { category: 'dev', source: 'title-keyword' };
  return { category: 'other', source: 'unclassified' };
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

async function buildSprintData(project, team, areaPath, sprintNames) {
  // Fetch the team's iterations up front — we need each requested sprint's real
  // full path (which may live under an intermediate node, not directly under the
  // project) before we can even run the WIQL query, plus its id for the capacity
  // lookup. One call serves both, instead of the two separate lookups this used
  // to do (and the second one used to arrive too late to fix the WIQL query).
  const iterations = await getTeamIterationsFull(project, team);
  const iterationByName = new Map(iterations.map((it) => [it.name, it]));

  const pathBySprintName = new Map(
    sprintNames.map((s) => {
      const it = iterationByName.get(s);
      // Fall back to the old "${project}\${name}" guess only for a sprint that
      // isn't in the team's current iteration list at all (e.g. a stale
      // SPRINT_ALLOWLIST entry) — degrade gracefully instead of crashing.
      return [s, it ? it.path : `${project}\\${s}`];
    })
  );
  const sprintNameByPath = new Map([...pathBySprintName].map(([name, path]) => [path, name]));

  const { storyIds, taskIds, pairs } = await getStoryTaskPairs(project, areaPath, [
    ...pathBySprintName.values(),
  ]);

  const [storyItems, taskItems] = await Promise.all([
    batchGetWorkItems(storyIds, [
      'System.Id',
      'System.Title',
      'System.IterationPath',
      'Microsoft.VSTS.Scheduling.StoryPoints',
    ]),
    batchGetWorkItems(taskIds, [
      'System.Id',
      'System.Title',
      'System.AssignedTo',
      'Microsoft.VSTS.Common.Activity',
      'Microsoft.VSTS.Scheduling.CompletedWork',
      'Microsoft.VSTS.Scheduling.OriginalEstimate',
      'Microsoft.VSTS.Scheduling.RemainingWork',
    ]),
  ]);

  // One capacity lookup per requested sprint (activities can differ sprint to sprint
  // as people rotate between dev and testing). Each result also carries which
  // capacity source actually served it ('rich' vs. the known-incomplete
  // 'rich-unavailable' fallback), which gets surfaced per sprint below so the
  // dashboard can show a warning when it's stuck with the limited data.
  const capacityResultBySprint = new Map(
    await Promise.all(
      sprintNames.map(async (s) => [
        s,
        await getSprintCapacityMap(project, team, iterationByName.get(s)?.id, s),
      ])
    )
  );

  const storyMap = new Map();
  for (const item of storyItems) {
    const iterationFull = item.fields['System.IterationPath'] || '';
    // Match the story's full IterationPath back to one of our requested sprint
    // names via the exact path map built above (handles nested iterations
    // correctly); fall back to stripping just the first segment for the rare
    // case a story's iteration wasn't one of the ones we resolved a path for.
    const sprintName =
      sprintNameByPath.get(iterationFull) ||
      (iterationFull.includes('\\') ? iterationFull.split('\\').slice(1).join('\\') : iterationFull);
    storyMap.set(item.id, {
      sprint: sprintName,
      title: item.fields['System.Title'] || `Story ${item.id}`,
      storyPoints: item.fields['Microsoft.VSTS.Scheduling.StoryPoints'] || 0,
    });
  }

  const taskMap = new Map();
  for (const item of taskItems) {
    taskMap.set(item.id, {
      title: item.fields['System.Title'] || `Task ${item.id}`,
      activity: item.fields['Microsoft.VSTS.Common.Activity'] || null,
      assignee: parseAssignedTo(item.fields['System.AssignedTo']),
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
        classifiedBy: {},
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

    const capacityResult = capacityResultBySprint.get(story.sprint);
    const { category: cat, source: classifiedBy } = classifyTask(
      task.title,
      task.activity,
      task.assignee,
      capacityResult && capacityResult.map
    );
    bucket[cat] += task.effort;
    bucket.classifiedBy[classifiedBy] = (bucket.classifiedBy[classifiedBy] || 0) + 1;
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
      assignedTo: task.assignee ? task.assignee.displayName : null,
      classifiedBy,
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
    const capacityResult = capacityResultBySprint.get(sprint);
    out[sprint] = {
      sp: round1(vals.sp),
      dev: round1(vals.dev),
      testing: round1(vals.testing),
      other: round1(vals.other),
      stories: vals.stories,
      classifiedBy: vals.classifiedBy,
      // 'rich' = got the complete Capacity list (same data the Sprints > Capacity
      // page itself shows); 'rich-unavailable' = fell back to the public REST
      // capacities endpoint, which is known to sometimes omit team members — the
      // frontend shows a warning toast for any selected sprint with this source.
      capacitySource: capacityResult ? capacityResult.source : 'rich-unavailable',
      // Only populated when capacitySource is 'rich-unavailable' — the actual
      // reason both the rich and basic lookups came up short for this sprint,
      // so a bad result is visible/debuggable instead of silently degrading.
      capacityError:
        capacityResult && capacityResult.source === 'rich-unavailable'
          ? { rich: capacityResult.richError || null, basic: capacityResult.basicError || null }
          : null,
      // The Capacity-tab roster for this sprint (who's on it + their raw
      // activities) — powers the "show the team" icon on each sprint row.
      roster: capacityResult
        ? [...capacityResult.roster].sort((a, b) => a.displayName.localeCompare(b.displayName))
        : [],
      details: vals.details,
    };
  }
  return out;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

// ---------- Routes ----------

// Scope discovery — powers the dashboard's Project / Team / Area Path dropdowns.

app.get('/api/projects', async (req, res) => {
  try {
    const cacheKey = 'projects';
    let projects = cache.get(cacheKey);
    if (!projects) {
      projects = await listProjects();
      cache.set(cacheKey, projects);
    }
    res.json({ projects, defaultProject: DEFAULT_PROJECT || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/teams', async (req, res) => {
  const project = req.query.project;
  if (!project) return res.status(400).json({ error: 'project query param is required' });
  try {
    const cacheKey = 'teams:' + project;
    let teams = cache.get(cacheKey);
    if (!teams) {
      teams = await listTeams(project);
      cache.set(cacheKey, teams);
    }
    // Only surface the .env default team if it actually belongs to this project —
    // a default carried over from a different project would be meaningless here.
    const defaultTeam = project === DEFAULT_PROJECT ? DEFAULT_TEAM || null : null;
    res.json({ teams, defaultTeam });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/areas', async (req, res) => {
  const project = req.query.project;
  if (!project) return res.status(400).json({ error: 'project query param is required' });
  try {
    const cacheKey = 'areas:' + project;
    let areas = cache.get(cacheKey);
    if (!areas) {
      areas = await listAreaPaths(project);
      cache.set(cacheKey, areas);
    }
    const defaultAreaPath = project === DEFAULT_PROJECT ? DEFAULT_AREA_PATH || null : null;
    res.json({ areas, defaultAreaPath });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sprints', async (req, res) => {
  const project = req.query.project || DEFAULT_PROJECT;
  const team = req.query.team || DEFAULT_TEAM;
  if (!project) {
    return res.status(400).json({ error: 'project query param is required (or set DEFAULT_PROJECT in .env)' });
  }
  try {
    const cacheKey = `sprint-list:${project}|${team || ''}`;
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

    if (!project || !areaPath) {
      return res.status(400).json({
        error:
          'project and areaPath query params are required (or set DEFAULT_PROJECT/DEFAULT_AREA_PATH in .env)',
      });
    }

    const requested = req.query.sprints
      ? String(req.query.sprints).split(',').map((s) => s.trim()).filter(Boolean)
      : await resolveSprintList(project, team);

    const cacheKey =
      `sprint-data:${project}|${team || ''}|${areaPath}|` + requested.slice().sort().join(',');
    const cached = cache.get(cacheKey);
    if (cached) {
      return res.json({ data: cached, cached: true });
    }

    const data = await buildSprintData(project, team, areaPath, requested);
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
