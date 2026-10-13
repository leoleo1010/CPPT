// Profession Custom — shared matching engine + Claude API client for CPPT.
// Loaded via <script src="professionCustom.js"> by both indexRew.html and indexRewIT.html.
// Every function is pure: ROLES/PATHS/pools/profession are passed in as arguments, nothing
// closes over file-local globals, so this one file works unchanged in both languages and
// is directly require()-able from Node for the deterministic-matching unit checks.

var PC_WEIGHT_TASKS = 0.25;
var PC_WEIGHT_SKILLS = 0.25;
var PC_WEIGHT_KNOWLEDGE = 0.25;
var PC_WEIGHT_COMPETENCES = 0.25;
var PC_COMPETENCE_LEVEL_PENALTY = 0.25; // credit lost per e-CF level of distance
var PC_TIER_CONTENT_WEIGHT = 0.7;
var PC_TIER_SENIORITY_WEIGHT = 0.3;
var PC_MAX_SENIORITY_ORDINAL = 4; // = max tiers.length across all 12 roles
var PC_DEFAULT_TOP_MATCHES = 3; // role+tier entries surfaced in the generated path
var PC_CAPABILITY_CONFIDENCE_THRESHOLD = 60; // % merge threshold for Claude's matches
var PC_API_MODEL = "claude-haiku-4-5-20251001"; // dated/pinned, not the floating alias
var PC_API_MAX_TOKENS = 4096;
var PC_API_KEY_STORAGE_KEY = "cppt.anthropicApiKey";

// ---------- Pool builders ----------

function pcDedupeStringPool(ROLES, field) {
  var byText = {};
  var pool = [];
  ROLES.forEach(function (role) {
    (role[field] || []).forEach(function (text, index) {
      var item = byText[text];
      if (!item) {
        item = { id: pool.length, text: text, occurrences: [] };
        byText[text] = item;
        pool.push(item);
      }
      item.occurrences.push({ roleId: role.id, index: index });
    });
  });
  return pool;
}

function pcBuildTaskPool(ROLES) { return pcDedupeStringPool(ROLES, "tasks"); }
function pcBuildSkillPool(ROLES) { return pcDedupeStringPool(ROLES, "skills"); }
function pcBuildKnowledgePool(ROLES) { return pcDedupeStringPool(ROLES, "knowledge"); }

function pcBuildCompetencePool(ROLES) {
  var byCode = {};
  var pool = [];
  ROLES.forEach(function (role) {
    (role.competences || []).forEach(function (c) {
      var item = byCode[c.code];
      if (!item) {
        item = { code: c.code, name: c.name, occurrences: [] };
        byCode[c.code] = item;
        pool.push(item);
      }
      item.occurrences.push({ roleId: role.id, level: c.level });
    });
  });
  return pool;
}

function pcBuildStagePool(ROLES, PATHS) {
  var pool = [];
  ROLES.forEach(function (role) {
    var data = PATHS[role.id];
    if (!data || !data.stages) return;
    data.stages.forEach(function (stage, stageIdx) {
      pool.push({
        uid: role.id + "::" + stage.id,
        roleId: role.id,
        stageIdx: stageIdx,
        tierId: stage.tier,
        title: stage.title,
        summary: stage.summary || stage.scenario || ""
      });
    });
  });
  return pool;
}

function pcBuildPools(ROLES, PATHS) {
  return {
    tasks: pcBuildTaskPool(ROLES),
    skills: pcBuildSkillPool(ROLES),
    knowledge: pcBuildKnowledgePool(ROLES),
    competences: pcBuildCompetencePool(ROLES),
    stages: pcBuildStagePool(ROLES, PATHS)
  };
}

// ---------- Custom profession state ----------

function pcCreateProfession(name) {
  return {
    name: name || "",
    selectedTaskIds: [],
    selectedSkillIds: [],
    selectedKnowledgeIds: [],
    selectedCompetences: [], // [{ code, targetLevel }]
    seniorityOrdinal: Math.ceil(PC_MAX_SENIORITY_ORDINAL / 2),
    concreteCapabilities: [] // [{ text, apiResult, apiError, apiPending }]
  };
}

// ---------- Role-level scoring ----------

function pcPoolById(pool) {
  var byId = {};
  pool.forEach(function (item) { byId[item.id] = item; });
  return byId;
}

function pcRoleHasOccurrence(poolItem, roleId) {
  return poolItem.occurrences.some(function (o) { return o.roleId === roleId; });
}

function pcOverlapScore(selectedIds, role, category, pools) {
  if (!selectedIds || !selectedIds.length) return null; // category untouched -> excluded, not zeroed
  var byId = pcPoolById(pools[category]);
  var matched = 0;
  selectedIds.forEach(function (id) {
    var item = byId[id];
    if (item && pcRoleHasOccurrence(item, role.id)) matched++;
  });
  return matched / selectedIds.length;
}

function pcCompetenceScore(selectedCompetences, role) {
  if (!selectedCompetences || !selectedCompetences.length) return null;
  var total = 0;
  selectedCompetences.forEach(function (sel) {
    var match = (role.competences || []).filter(function (c) { return c.code === sel.code; })[0];
    if (!match) return; // zero credit — code not present in this role at all
    total += Math.max(0, 1 - Math.abs(match.level - sel.targetLevel) * PC_COMPETENCE_LEVEL_PENALTY);
  });
  return total / selectedCompetences.length;
}

// Generic renormalizing combiner — only non-null categories count, so leaving a
// category empty never silently drags the score toward 0.
function pcWeightedScore(scoreMap, weightMap) {
  var sum = 0;
  var wTotal = 0;
  Object.keys(weightMap).forEach(function (key) {
    var score = scoreMap[key];
    if (score === null || score === undefined) return;
    sum += weightMap[key] * score;
    wTotal += weightMap[key];
  });
  return wTotal === 0 ? 0 : sum / wTotal;
}

function pcRoleAffinity(customProfession, role, pools) {
  var scoreMap = {
    tasks: pcOverlapScore(customProfession.selectedTaskIds, role, "tasks", pools),
    skills: pcOverlapScore(customProfession.selectedSkillIds, role, "skills", pools),
    knowledge: pcOverlapScore(customProfession.selectedKnowledgeIds, role, "knowledge", pools),
    competences: pcCompetenceScore(customProfession.selectedCompetences, role)
  };
  var weightMap = {
    tasks: PC_WEIGHT_TASKS,
    skills: PC_WEIGHT_SKILLS,
    knowledge: PC_WEIGHT_KNOWLEDGE,
    competences: PC_WEIGHT_COMPETENCES
  };
  return { percent: Math.round(pcWeightedScore(scoreMap, weightMap) * 100), breakdown: scoreMap };
}

// ---------- Tier refinement ----------

// Role-agnostic ordinal (1..PC_MAX_SENIORITY_ORDINAL) -> that role's actual tier index,
// since tiers aren't uniformly named/counted across roles (2-4 tiers each).
function pcSeniorityTierIndex(tierCount, desiredOrdinal) {
  if (!tierCount || tierCount <= 1) return 0;
  var fraction = (desiredOrdinal - 1) / (PC_MAX_SENIORITY_ORDINAL - 1);
  var idx = Math.round(fraction * (tierCount - 1));
  return Math.max(0, Math.min(tierCount - 1, idx));
}

// Global pool ids the user selected -> that role's own local tasks/skills/knowledge indexes,
// so stage.taskIdx/skillIdx/knowledgeIdx (which are role-local) can be compared directly.
function pcLocalIndexSet(selectedIds, role, category, pools) {
  var byId = pcPoolById(pools[category]);
  var set = {};
  (selectedIds || []).forEach(function (id) {
    var item = byId[id];
    if (!item) return;
    item.occurrences.forEach(function (o) {
      if (o.roleId === role.id) set[o.index] = true;
    });
  });
  return set;
}

function pcIndexOverlapFraction(stageIdxArray, selectedLocalSet) {
  if (!stageIdxArray || !stageIdxArray.length) return null;
  var matched = 0;
  stageIdxArray.forEach(function (idx) {
    if (selectedLocalSet[idx]) matched++;
  });
  return matched / stageIdxArray.length;
}

function pcStageContentScore(stage, customProfession, role, pools) {
  var scoreMap = {
    tasks: pcIndexOverlapFraction(stage.taskIdx, pcLocalIndexSet(customProfession.selectedTaskIds, role, "tasks", pools)),
    skills: pcIndexOverlapFraction(stage.skillIdx, pcLocalIndexSet(customProfession.selectedSkillIds, role, "skills", pools)),
    knowledge: pcIndexOverlapFraction(stage.knowledgeIdx, pcLocalIndexSet(customProfession.selectedKnowledgeIds, role, "knowledge", pools))
  };
  return pcWeightedScore(scoreMap, { tasks: 1, skills: 1, knowledge: 1 });
}

function pcTierMatch(customProfession, role, tier, tierIndex, tierCount, stages, pools) {
  var bestScore = -1;
  var bestStageIdx = -1;
  (stages || []).forEach(function (stage, idx) {
    if (stage.tier !== tier.id) return;
    var score = pcStageContentScore(stage, customProfession, role, pools);
    if (score > bestScore) { bestScore = score; bestStageIdx = idx; }
  });
  if (bestStageIdx === -1) bestScore = 0;

  var desiredIdx = pcSeniorityTierIndex(tierCount, customProfession.seniorityOrdinal);
  var proximity = tierCount <= 1 ? 1 : 1 - Math.abs(tierIndex - desiredIdx) / (tierCount - 1);

  return {
    tierId: tier.id,
    tierIndex: tierIndex,
    tierName: tier.name,
    contentScore: bestScore,
    seniorityProximity: proximity,
    combinedScore: PC_TIER_CONTENT_WEIGHT * bestScore + PC_TIER_SENIORITY_WEIGHT * proximity,
    bestStageIdx: bestStageIdx
  };
}

function pcBestTierForRole(customProfession, role, pathData, pools) {
  if (!pathData || !pathData.tiers || !pathData.tiers.length) return null;
  var tierCount = pathData.tiers.length;
  var allTiers = pathData.tiers.map(function (tier, tierIndex) {
    return pcTierMatch(customProfession, role, tier, tierIndex, tierCount, pathData.stages || [], pools);
  });
  var best = allTiers.reduce(function (a, b) { return b.combinedScore > a.combinedScore ? b : a; }, allTiers[0]);
  return { best: best, allTiers: allTiers };
}

// ---------- Top-level matching + generated path ----------

function pcMatchAll(customProfession, ROLES, PATHS, pools) {
  var results = ROLES.map(function (role) {
    var affinity = pcRoleAffinity(customProfession, role, pools);
    var tierInfo = pcBestTierForRole(customProfession, role, PATHS[role.id], pools);
    return {
      roleId: role.id,
      role: role,
      percent: affinity.percent,
      breakdown: affinity.breakdown,
      bestTier: tierInfo ? tierInfo.best : null,
      allTiers: tierInfo ? tierInfo.allTiers : []
    };
  });
  results.sort(function (a, b) { return b.percent - a.percent; });
  return results;
}

function pcGenerateLearningPath(matchResults, PATHS, topN) {
  var n = topN || PC_DEFAULT_TOP_MATCHES;
  var entries = [];
  for (var i = 0; i < matchResults.length && entries.length < n; i++) {
    var m = matchResults[i];
    if (!m.bestTier || m.bestTier.bestStageIdx === -1) continue;
    var pathData = PATHS[m.roleId];
    var stage = pathData.stages[m.bestTier.bestStageIdx];
    entries.push({
      roleId: m.roleId,
      stageIdx: m.bestTier.bestStageIdx,
      stage: stage,
      tierName: m.bestTier.tierName,
      percent: m.percent,
      source: "affinity",
      fromCapabilityText: null
    });
  }
  return entries;
}

// Folds Claude's per-capability results (already attached to customProfession.concreteCapabilities[i].apiResult)
// into (a) extra skill/knowledge ids to union into scoring, and (b) extra path entries for directly-matched
// stages, deduped against the affinity-sourced entries already in `existingPathEntries`.
function pcMergeConcreteCapabilityMatches(customProfession, pools, PATHS, existingPathEntries) {
  var extraSkillIds = {};
  var extraKnowledgeIds = {};
  var extraPathEntries = [];
  var existingKeys = {};
  (existingPathEntries || []).forEach(function (e) { existingKeys[e.roleId + "::" + e.stageIdx] = true; });

  (customProfession.concreteCapabilities || []).forEach(function (cap) {
    if (!cap.apiResult) return;

    (cap.apiResult.skills || []).forEach(function (m) {
      if (m.percent >= PC_CAPABILITY_CONFIDENCE_THRESHOLD) extraSkillIds[m.id] = true;
    });
    (cap.apiResult.knowledge || []).forEach(function (m) {
      if (m.percent >= PC_CAPABILITY_CONFIDENCE_THRESHOLD) extraKnowledgeIds[m.id] = true;
    });
    (cap.apiResult.stages || []).forEach(function (m) {
      if (m.percent < PC_CAPABILITY_CONFIDENCE_THRESHOLD) return;
      var stagePoolItem = pools.stages.filter(function (s) { return s.uid === m.id; })[0];
      if (!stagePoolItem) return;
      var key = stagePoolItem.roleId + "::" + stagePoolItem.stageIdx;
      if (existingKeys[key]) return;
      existingKeys[key] = true;

      var pathData = PATHS[stagePoolItem.roleId];
      var stage = pathData && pathData.stages[stagePoolItem.stageIdx];
      var tier = stage && (pathData.tiers || []).filter(function (t) { return t.id === stage.tier; })[0];
      extraPathEntries.push({
        roleId: stagePoolItem.roleId,
        stageIdx: stagePoolItem.stageIdx,
        stage: stage,
        tierName: tier ? tier.name : null,
        percent: m.percent,
        source: "concrete-capability",
        fromCapabilityText: cap.text
      });
    });
  });

  return {
    extraSelectedSkillIds: Object.keys(extraSkillIds).map(Number),
    extraSelectedKnowledgeIds: Object.keys(extraKnowledgeIds).map(Number),
    extraPathEntries: extraPathEntries
  };
}

// ---------- localStorage-backed API key (first use of localStorage in this codebase) ----------

function pcLoadApiKey() {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(PC_API_KEY_STORAGE_KEY);
  } catch (e) { return null; }
}

function pcSaveApiKey(key) {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(PC_API_KEY_STORAGE_KEY, key);
  } catch (e) { /* storage unavailable (private mode, quota, etc.) — silently skip */ }
}

function pcClearApiKey() {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(PC_API_KEY_STORAGE_KEY);
  } catch (e) { /* ignore */ }
}

// ---------- Claude API client ----------

function pcBuildCapabilityRequestBody(capabilityText, pools) {
  var skillIds = pools.skills.map(function (s) { return s.id; });
  var knowledgeIds = pools.knowledge.map(function (k) { return k.id; });
  var stageUids = pools.stages.map(function (s) { return s.uid; });

  return {
    model: PC_API_MODEL,
    max_tokens: PC_API_MAX_TOKENS,
    system: "You are a precise skills-taxonomy matcher for a cybersecurity training platform. " +
      "The user describes one concrete, hands-on professional capability (a tool, technique or " +
      "specific ability). Score how strongly it associates with each candidate skill, knowledge " +
      "area and lab/tabletop exercise given to you, as an integer percentage from 0 to 100. " +
      "Only ever return ids that appear in the candidate lists you are given — never invent an id. " +
      "If nothing in a list is a genuine match, return an empty array for that list.",
    messages: [{
      role: "user",
      content: JSON.stringify({
        capability: capabilityText,
        skills: pools.skills.map(function (s) { return { id: s.id, text: s.text }; }),
        knowledge: pools.knowledge.map(function (k) { return { id: k.id, text: k.text }; }),
        stages: pools.stages.map(function (s) { return { id: s.uid, title: s.title, summary: s.summary }; })
      })
    }],
    output_config: {
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            skills: { type: "array", items: { type: "object",
              properties: { id: { type: "integer", enum: skillIds }, percent: { type: "integer" } },
              required: ["id", "percent"], additionalProperties: false } },
            knowledge: { type: "array", items: { type: "object",
              properties: { id: { type: "integer", enum: knowledgeIds }, percent: { type: "integer" } },
              required: ["id", "percent"], additionalProperties: false } },
            stages: { type: "array", items: { type: "object",
              properties: { id: { type: "string", enum: stageUids }, percent: { type: "integer" } },
              required: ["id", "percent"], additionalProperties: false } }
          },
          required: ["skills", "knowledge", "stages"],
          additionalProperties: false
        }
      }
    }
  };
}

function pcValidateCapabilityResponse(parsed, pools) {
  function validList(list, idSet, idKey) {
    if (!Array.isArray(list)) return [];
    var out = [];
    list.forEach(function (item) {
      if (!item || !idSet[item[idKey]]) return; // defense-in-depth beyond the request-time enum
      var percent = Math.max(0, Math.min(100, Math.round(Number(item.percent) || 0)));
      var entry = {};
      entry[idKey] = item[idKey];
      entry.percent = percent;
      out.push(entry);
    });
    return out;
  }
  var skillIdSet = {}; pools.skills.forEach(function (s) { skillIdSet[s.id] = true; });
  var knowledgeIdSet = {}; pools.knowledge.forEach(function (k) { knowledgeIdSet[k.id] = true; });
  var stageUidSet = {}; pools.stages.forEach(function (s) { stageUidSet[s.uid] = true; });
  return {
    skills: validList(parsed.skills, skillIdSet, "id"),
    knowledge: validList(parsed.knowledge, knowledgeIdSet, "id"),
    stages: validList(parsed.stages, stageUidSet, "id")
  };
}

// Returns a Promise resolving to a pcValidateCapabilityResponse() result, or rejecting with
// { kind, message } — kind is one of: no-key, invalid-key, network, http-error, retryable,
// refusal, truncated, malformed.
function pcCallClaudeForCapability(apiKey, capabilityText, pools) {
  if (!apiKey) {
    return Promise.reject({ kind: "no-key", message: "No Anthropic API key configured." });
  }
  var requestBody = pcBuildCapabilityRequestBody(capabilityText, pools);
  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify(requestBody)
  }).then(function (response) {
    return response.json().catch(function () { return null; }).then(function (data) {
      if (!response.ok) {
        var errType = data && data.error && data.error.type;
        if (response.status === 401 || errType === "authentication_error") {
          return Promise.reject({ kind: "invalid-key", message: "Your API key was rejected — check it and try again." });
        }
        if (response.status === 429 || response.status === 500 || response.status === 529) {
          return Promise.reject({ kind: "retryable", message: "Temporary failure reaching the Anthropic API — try again." });
        }
        return Promise.reject({ kind: "http-error", message: "Request was rejected (" + response.status + ")." });
      }
      if (!data) {
        return Promise.reject({ kind: "malformed", message: "Unexpected response format — try again." });
      }
      if (data.stop_reason === "refusal") {
        return Promise.reject({ kind: "refusal", message: "The request was declined by Anthropic's safety system." });
      }
      if (data.stop_reason === "max_tokens") {
        return Promise.reject({ kind: "truncated", message: "The response was cut off — try a shorter description." });
      }
      var text = data.content && data.content[0] && data.content[0].text;
      var parsed;
      try { parsed = JSON.parse(text); }
      catch (e) { return Promise.reject({ kind: "malformed", message: "Unexpected response format — try again." }); }
      return pcValidateCapabilityResponse(parsed, pools);
    });
  }, function () {
    return Promise.reject({ kind: "network", message: "Could not reach the Anthropic API — check your connection, or that this browser allows direct API calls." });
  });
}

// ---------- Claude-reasoned affinity (full-selection reasoning) ----------
//
// The deterministic pipeline above (pcMatchAll etc.) remains the always-available, zero-key
// fallback. This second API call type lets Claude reason over the *whole* selection at once —
// tasks + skills + knowledge + competences + seniority + free-text "concrete capabilities" —
// and produce the role affinities directly, instead of pure local arithmetic. Mirrors the
// pcBuildCapabilityRequestBody / pcCallClaudeForCapability / pcValidateCapabilityResponse
// pattern exactly: same headers, same output_config.format json_schema approach, same
// {kind,message} rejection vocabulary.

function pcBuildAffinityRequestBody(customProfession, pools, ROLES, PATHS, lang) {
  var taskById = pcPoolById(pools.tasks);
  var skillById = pcPoolById(pools.skills);
  var knowledgeById = pcPoolById(pools.knowledge);
  var competenceByCode = {};
  pools.competences.forEach(function (c) { competenceByCode[c.code] = c; });

  var selectedTasks = (customProfession.selectedTaskIds || []).map(function (id) {
    return taskById[id] && taskById[id].text;
  }).filter(Boolean);
  var selectedSkills = (customProfession.selectedSkillIds || []).map(function (id) {
    return skillById[id] && skillById[id].text;
  }).filter(Boolean);
  var selectedKnowledge = (customProfession.selectedKnowledgeIds || []).map(function (id) {
    return knowledgeById[id] && knowledgeById[id].text;
  }).filter(Boolean);
  var selectedCompetences = (customProfession.selectedCompetences || []).map(function (sel) {
    var item = competenceByCode[sel.code];
    return { code: sel.code, name: item ? item.name : sel.code, targetLevel: sel.targetLevel };
  });
  var concreteCapabilities = (customProfession.concreteCapabilities || [])
    .map(function (c) { return (c.text || "").trim(); })
    .filter(Boolean);

  var roleIds = ROLES.map(function (r) { return r.id; });
  var roleCatalog = ROLES.map(function (r) {
    var pathData = PATHS[r.id];
    return {
      id: r.id,
      title: r.title,
      summary: r.summary,
      tiers: (pathData && pathData.tiers || []).map(function (t) { return { id: t.id, name: t.name }; })
    };
  });

  var langName = lang === "it" ? "Italian" : "English";

  return {
    model: PC_API_MODEL,
    max_tokens: PC_API_MAX_TOKENS,
    system: "You are a careful ECSF role-affinity reasoner for a cybersecurity training platform. " +
      "You are given one custom profession's full selection — tasks, skills, knowledge, e-CF " +
      "competences with target levels, a seniority ordinal (1 = most junior, " + PC_MAX_SENIORITY_ORDINAL +
      " = most senior), and free-text 'concrete capabilities' the person described in their own words " +
      "— plus a catalogue of the 12 real ECSF roles, each with its real career tiers. Reason step by " +
      "step about how well this profession fits each role and which tier best matches its seniority, " +
      "grounding every judgement only in the selection and catalogue given to you — never invent a role, " +
      "tier, or fact not present in the input. Then return one affinity entry for every role id in the " +
      "catalogue (use 0 for roles with no genuine fit) and a short (2-4 sentence) plain-language synthesis " +
      "of your reasoning, written in " + langName + ".",
    messages: [{
      role: "user",
      content: JSON.stringify({
        profession: {
          name: customProfession.name,
          selectedTasks: selectedTasks,
          selectedSkills: selectedSkills,
          selectedKnowledge: selectedKnowledge,
          selectedCompetences: selectedCompetences,
          seniorityOrdinal: customProfession.seniorityOrdinal,
          maxSeniorityOrdinal: PC_MAX_SENIORITY_ORDINAL,
          concreteCapabilities: concreteCapabilities
        },
        roles: roleCatalog
      })
    }],
    output_config: {
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            reasoning: { type: "string" },
            affinities: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  roleId: { type: "string", enum: roleIds },
                  percent: { type: "integer" },
                  tierId: { type: "string" }
                },
                required: ["roleId", "percent", "tierId"],
                additionalProperties: false
              }
            }
          },
          required: ["reasoning", "affinities"],
          additionalProperties: false
        }
      }
    }
  };
}

// Defense-in-depth beyond the request-time enum: rebuilds real id sets from the live
// ROLES/PATHS, clamps percent into [0,100], and validates tierId against that specific role's
// real tiers — falling back to the seniority-proportional tier (pcSeniorityTierIndex) rather
// than trusting an unvalidated claim. Which *stage* to recommend within the chosen tier is
// still always resolved locally via pcTierMatch's real task/skill/knowledge overlap — Claude
// picks the role+tier, local math picks the specific lab, so a lab recommendation is never
// invented by the model.
function pcValidateAffinityResponse(parsed, customProfession, ROLES, PATHS, pools) {
  var roleById = {};
  ROLES.forEach(function (r) { roleById[r.id] = r; });

  var reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning.slice(0, 2000) : "";
  var list = Array.isArray(parsed.affinities) ? parsed.affinities : [];
  var seenRoleIds = {};
  var matches = [];

  list.forEach(function (entry) {
    if (!entry || seenRoleIds[entry.roleId]) return;
    var role = roleById[entry.roleId];
    if (!role) return;
    var pathData = PATHS[role.id];
    if (!pathData || !pathData.tiers || !pathData.tiers.length) return;
    seenRoleIds[entry.roleId] = true;

    var percent = Math.max(0, Math.min(100, Math.round(Number(entry.percent) || 0)));
    var tierIndex = -1;
    for (var i = 0; i < pathData.tiers.length; i++) {
      if (pathData.tiers[i].id === entry.tierId) { tierIndex = i; break; }
    }
    if (tierIndex === -1) tierIndex = pcSeniorityTierIndex(pathData.tiers.length, customProfession.seniorityOrdinal);
    var tier = pathData.tiers[tierIndex];

    var bestTier = pcTierMatch(customProfession, role, tier, tierIndex, pathData.tiers.length, pathData.stages || [], pools);
    matches.push({ roleId: role.id, role: role, percent: percent, bestTier: bestTier, allTiers: [] });
  });

  matches.sort(function (a, b) { return b.percent - a.percent; });
  return { reasoning: reasoning, matches: matches };
}

// Returns a Promise resolving to { reasoning, matches } (matches shaped identically to
// pcMatchAll's output, so pcGenerateLearningPath works unchanged on either source), or
// rejecting with { kind, message } — same kind vocabulary as pcCallClaudeForCapability.
function pcCallClaudeForAffinity(apiKey, customProfession, pools, ROLES, PATHS, lang) {
  if (!apiKey) {
    return Promise.reject({ kind: "no-key", message: "No Anthropic API key configured." });
  }
  var requestBody = pcBuildAffinityRequestBody(customProfession, pools, ROLES, PATHS, lang);
  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify(requestBody)
  }).then(function (response) {
    return response.json().catch(function () { return null; }).then(function (data) {
      if (!response.ok) {
        var errType = data && data.error && data.error.type;
        if (response.status === 401 || errType === "authentication_error") {
          return Promise.reject({ kind: "invalid-key", message: "Your API key was rejected — check it and try again." });
        }
        if (response.status === 429 || response.status === 500 || response.status === 529) {
          return Promise.reject({ kind: "retryable", message: "Temporary failure reaching the Anthropic API — try again." });
        }
        return Promise.reject({ kind: "http-error", message: "Request was rejected (" + response.status + ")." });
      }
      if (!data) {
        return Promise.reject({ kind: "malformed", message: "Unexpected response format — try again." });
      }
      if (data.stop_reason === "refusal") {
        return Promise.reject({ kind: "refusal", message: "The request was declined by Anthropic's safety system." });
      }
      if (data.stop_reason === "max_tokens") {
        return Promise.reject({ kind: "truncated", message: "The response was cut off — try a smaller selection." });
      }
      var text = data.content && data.content[0] && data.content[0].text;
      var parsed;
      try { parsed = JSON.parse(text); }
      catch (e) { return Promise.reject({ kind: "malformed", message: "Unexpected response format — try again." }); }
      return pcValidateAffinityResponse(parsed, customProfession, ROLES, PATHS, pools);
    });
  }, function () {
    return Promise.reject({ kind: "network", message: "Could not reach the Anthropic API — check your connection, or that this browser allows direct API calls." });
  });
}

// ---------- Claude-reasoned sequential path (tier ladder for a custom profession) ----------
//
// pcGenerateLearningPath / pcMergeConcreteCapabilityMatches already decide WHICH real labs are
// relevant (grounded local math, unchanged). This reasons about ORDER: grouping that fixed,
// already-grounded candidate set into a foundational-to-advanced progression, mirroring how
// the real roles organise their own labs into career tiers (PATHS[roleId].tiers) — but
// synthesized for this one custom profession. Claude can only reorder/group the given
// candidates; it can never add, drop, rename or invent a lab.

function pcPathEntryKey(entry) { return entry.roleId + "::" + entry.stageIdx; }

function pcBuildSequenceRequestBody(customProfession, pathEntries, ROLES, lang) {
  var roleById = {};
  ROLES.forEach(function (r) { roleById[r.id] = r; });

  var candidates = pathEntries.map(function (e) {
    var role = roleById[e.roleId];
    return {
      key: pcPathEntryKey(e),
      role: role ? role.title : e.roleId,
      lab: e.stage.title,
      relevance: e.percent,
      via: e.fromCapabilityText || null
    };
  });
  var keys = candidates.map(function (c) { return c.key; });
  var langName = lang === "it" ? "Italian" : "English";

  return {
    model: PC_API_MODEL,
    max_tokens: PC_API_MAX_TOKENS,
    system: "You sequence a fixed set of real cybersecurity training labs into a foundational-to-advanced " +
      "learning progression for one custom profession, mirroring how this platform's own 12 standard roles " +
      "organise their labs into career tiers. You are given the exact labs already judged relevant to this " +
      "profession (role, lab title, relevance score, and — if present — which concrete capability surfaced " +
      "it). Group them into 2 to 4 sequential tiers, earliest/most foundational first. Every given lab must " +
      "appear in exactly one tier; never add, remove, rename or invent a lab. Give each tier a short " +
      "descriptive name and a one-sentence rationale, written in " + langName + ".",
    messages: [{
      role: "user",
      content: JSON.stringify({
        profession: { name: customProfession.name, seniorityOrdinal: customProfession.seniorityOrdinal },
        candidates: candidates
      })
    }],
    output_config: {
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            tiers: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  note: { type: "string" },
                  stageKeys: { type: "array", items: { type: "string", enum: keys } }
                },
                required: ["name", "note", "stageKeys"],
                additionalProperties: false
              }
            }
          },
          required: ["tiers"],
          additionalProperties: false
        }
      }
    }
  };
}

// Defense-in-depth beyond the request-time enum: rebuilds the candidate set from the live
// pathEntries, drops any key that doesn't exist or was already used by an earlier tier (no
// lab appears twice), and appends any candidate Claude silently dropped to one trailing tier
// so nothing requested is ever lost.
function pcValidateSequenceResponse(parsed, pathEntries) {
  var byKey = {};
  pathEntries.forEach(function (e) { byKey[pcPathEntryKey(e)] = e; });
  var seen = {};
  var tiers = [];

  var rawTiers = Array.isArray(parsed.tiers) ? parsed.tiers : [];
  rawTiers.forEach(function (t) {
    var entries = [];
    (Array.isArray(t.stageKeys) ? t.stageKeys : []).forEach(function (k) {
      if (seen[k] || !byKey[k]) return;
      seen[k] = true;
      entries.push(byKey[k]);
    });
    if (entries.length) {
      tiers.push({
        name: typeof t.name === "string" ? t.name.slice(0, 120) : "",
        note: typeof t.note === "string" ? t.note.slice(0, 400) : "",
        entries: entries
      });
    }
  });

  var leftovers = pathEntries.filter(function (e) { return !seen[pcPathEntryKey(e)]; });
  if (leftovers.length) {
    tiers.push({ name: "", note: "", entries: leftovers });
  }

  return { tiers: tiers };
}

function pcCallClaudeForSequence(apiKey, customProfession, pathEntries, ROLES, lang) {
  if (!apiKey) {
    return Promise.reject({ kind: "no-key", message: "No Anthropic API key configured." });
  }
  var requestBody = pcBuildSequenceRequestBody(customProfession, pathEntries, ROLES, lang);
  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify(requestBody)
  }).then(function (response) {
    return response.json().catch(function () { return null; }).then(function (data) {
      if (!response.ok) {
        var errType = data && data.error && data.error.type;
        if (response.status === 401 || errType === "authentication_error") {
          return Promise.reject({ kind: "invalid-key", message: "Your API key was rejected — check it and try again." });
        }
        if (response.status === 429 || response.status === 500 || response.status === 529) {
          return Promise.reject({ kind: "retryable", message: "Temporary failure reaching the Anthropic API — try again." });
        }
        return Promise.reject({ kind: "http-error", message: "Request was rejected (" + response.status + ")." });
      }
      if (!data) {
        return Promise.reject({ kind: "malformed", message: "Unexpected response format — try again." });
      }
      if (data.stop_reason === "refusal") {
        return Promise.reject({ kind: "refusal", message: "The request was declined by Anthropic's safety system." });
      }
      if (data.stop_reason === "max_tokens") {
        return Promise.reject({ kind: "truncated", message: "The response was cut off — try again." });
      }
      var text = data.content && data.content[0] && data.content[0].text;
      var parsed;
      try { parsed = JSON.parse(text); }
      catch (e) { return Promise.reject({ kind: "malformed", message: "Unexpected response format — try again." }); }
      return pcValidateSequenceResponse(parsed, pathEntries);
    });
  }, function () {
    return Promise.reject({ kind: "network", message: "Could not reach the Anthropic API — check your connection, or that this browser allows direct API calls." });
  });
}

// Node/CommonJS export for the deterministic-matching unit checks (no-op in the browser,
// where this whole file runs as a plain non-module <script> and every function above is
// already a global via normal script-tag semantics).
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    PC_WEIGHT_TASKS: PC_WEIGHT_TASKS,
    PC_WEIGHT_SKILLS: PC_WEIGHT_SKILLS,
    PC_WEIGHT_KNOWLEDGE: PC_WEIGHT_KNOWLEDGE,
    PC_WEIGHT_COMPETENCES: PC_WEIGHT_COMPETENCES,
    PC_COMPETENCE_LEVEL_PENALTY: PC_COMPETENCE_LEVEL_PENALTY,
    PC_TIER_CONTENT_WEIGHT: PC_TIER_CONTENT_WEIGHT,
    PC_TIER_SENIORITY_WEIGHT: PC_TIER_SENIORITY_WEIGHT,
    PC_MAX_SENIORITY_ORDINAL: PC_MAX_SENIORITY_ORDINAL,
    PC_DEFAULT_TOP_MATCHES: PC_DEFAULT_TOP_MATCHES,
    PC_CAPABILITY_CONFIDENCE_THRESHOLD: PC_CAPABILITY_CONFIDENCE_THRESHOLD,
    PC_API_MODEL: PC_API_MODEL,
    PC_API_MAX_TOKENS: PC_API_MAX_TOKENS,
    PC_API_KEY_STORAGE_KEY: PC_API_KEY_STORAGE_KEY,
    pcBuildTaskPool: pcBuildTaskPool,
    pcBuildSkillPool: pcBuildSkillPool,
    pcBuildKnowledgePool: pcBuildKnowledgePool,
    pcBuildCompetencePool: pcBuildCompetencePool,
    pcBuildStagePool: pcBuildStagePool,
    pcBuildPools: pcBuildPools,
    pcCreateProfession: pcCreateProfession,
    pcOverlapScore: pcOverlapScore,
    pcCompetenceScore: pcCompetenceScore,
    pcWeightedScore: pcWeightedScore,
    pcRoleAffinity: pcRoleAffinity,
    pcSeniorityTierIndex: pcSeniorityTierIndex,
    pcStageContentScore: pcStageContentScore,
    pcTierMatch: pcTierMatch,
    pcBestTierForRole: pcBestTierForRole,
    pcMatchAll: pcMatchAll,
    pcGenerateLearningPath: pcGenerateLearningPath,
    pcMergeConcreteCapabilityMatches: pcMergeConcreteCapabilityMatches,
    pcLoadApiKey: pcLoadApiKey,
    pcSaveApiKey: pcSaveApiKey,
    pcClearApiKey: pcClearApiKey,
    pcBuildCapabilityRequestBody: pcBuildCapabilityRequestBody,
    pcValidateCapabilityResponse: pcValidateCapabilityResponse,
    pcCallClaudeForCapability: pcCallClaudeForCapability,
    pcBuildAffinityRequestBody: pcBuildAffinityRequestBody,
    pcValidateAffinityResponse: pcValidateAffinityResponse,
    pcCallClaudeForAffinity: pcCallClaudeForAffinity,
    pcPathEntryKey: pcPathEntryKey,
    pcBuildSequenceRequestBody: pcBuildSequenceRequestBody,
    pcValidateSequenceResponse: pcValidateSequenceResponse,
    pcCallClaudeForSequence: pcCallClaudeForSequence
  };
}
