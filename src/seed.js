import { randomUUID } from 'node:crypto';
import { rumorFromPayload } from './llm.js';
import { DEFAULT_RUMOR_REGISTERS, pickRumorRegister } from './register.js';
import { hearerIdsForRoles, pickGossipRoles, rumorTargetSetKey, wrapRumor } from './roles.js';
import {
  appendGeneratedGossipHistory,
  currentTidbits,
  generatedGossipHistory,
  pruneGossipCommentsToTidbits,
  tidbitKey,
} from './store.js';
import { validateRumor } from './validate.js';
import { reviewGossipBatch } from './review.js';

export function stationDay(now = new Date(), timeZone = 'UTC') {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

function tidbitFromRoles(roles, rumor, createdAt) {
  return {
    id: randomUUID(),
    text: wrapRumor(roles, rumor),
    createdAt,
    tellerPersonaId: roles.teller.id,
    hearerPersonaIds: hearerIdsForRoles(roles),
  };
}

async function generateOne({
  generate,
  roster,
  houseRules = '',
  roles,
  register,
  day,
  existing,
  sessionTidbits = [],
  previousTidbit = '',
  createdAt,
  log,
  sleep = defaultSleep,
  minLength = 20,
}) {
  const maxAttempts = 3;
  let lastReason = 'empty-text';
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const payload = await generate({
        personas: roster,
        houseRules,
        day,
        roles,
        register,
        existing,
        sessionTidbits,
        previousTidbit,
        attempt,
      });
      const rumor = rumorFromPayload(payload);
      const check = validateRumor(rumor, { targets: roles.targets, minLength, maxLength: 240 });
      if (check.ok) return { ok: true, tidbit: tidbitFromRoles(roles, rumor, createdAt) };
      lastReason = check.reason;
      log.warn?.(`[gossip] rumor rejected attempt=${attempt}/${maxAttempts}: ${check.reason}`);
    } catch (err) {
      if (err?.status === 429) {
        const delay = Math.min(60_000, 1_000 * (2 ** Math.min(attempt - 1, 5)));
        log.warn?.(`[gossip] LLM rate limited; retrying in ${delay}ms`);
        await sleep(delay);
        attempt -= 1;
        continue;
      }
      throw err;
    }
  }
  return { ok: false, reason: lastReason };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TARGET_SET_PICK_ATTEMPTS = 3;

function applyUncoveredHearerBias(roles, roster, involved) {
  const uncovered = roster.filter((persona) => !involved.has(persona.id));
  if (!roles || !uncovered.length) return roles;
  if (roles.teller.id === uncovered[0].id || roles.hearers.some((p) => p.id === uncovered[0].id)) {
    return roles;
  }
  const hearers = roles.hearers.length >= 3
    ? [...roles.hearers.slice(0, 2), uncovered[0]]
    : [...roles.hearers, uncovered[0]];
  return { ...roles, hearers };
}

function applyUncoveredTargetBias(roles, roster, targetCovered) {
  const uncovered = roster.filter((persona) => !targetCovered.has(persona.id));
  if (!roles || !uncovered.length) return roles;
  if (roles.targets.some((p) => p.id === uncovered[0].id)) return roles;
  const blocked = new Set([roles.teller.id, ...roles.hearers.map((p) => p.id)]);
  if (blocked.has(uncovered[0].id)) return roles;
  const maxTargets = 2;
  if (roles.targets.length < maxTargets) {
    return { ...roles, targets: [...roles.targets, uncovered[0]] };
  }
  const replaceIndex = roles.targets.findIndex((p) => targetCovered.has(p.id));
  if (replaceIndex === -1) return roles;
  const nextTargets = roles.targets.slice();
  nextTargets[replaceIndex] = uncovered[0];
  return { ...roles, targets: nextTargets };
}

function pickRolesAvoidingUsedTargetSets(chooseRoles, roster, involved, targetCovered, usedTargetSets) {
  let roles = null;
  for (let attempt = 0; attempt < TARGET_SET_PICK_ATTEMPTS; attempt += 1) {
    roles = applyUncoveredHearerBias(chooseRoles(roster), roster, involved);
    roles = applyUncoveredTargetBias(roles, roster, targetCovered);
    if (!roles) return null;
    if (!usedTargetSets.has(rumorTargetSetKey(roles.targets))) return roles;
  }
  return roles;
}

function refreshCompletenessShortfall(involved, targetCovered, roster) {
  const participationIncomplete = involved.size < roster.length;
  const targetIncomplete = targetCovered.size < roster.length;
  if (!participationIncomplete && !targetIncomplete) return null;
  return { participationIncomplete, targetIncomplete };
}

export async function seedGossip({
  store,
  adapter,
  generate,
  cap,
  historyGenerations,
  now = new Date(),
  log = console,
  timezone,
  pickRoles,
  pickRegister,
  rumorRegisters,
  sleep,
  minLength = 20,
  reviewRounds = 0,
  generateReview,
}) {
  const chooseRoles = pickRoles || pickGossipRoles;
  const catalog = rumorRegisters ?? DEFAULT_RUMOR_REGISTERS;
  const chooseRegister = pickRegister || (() => pickRumorRegister({ catalog }));
  const [roster, houseRules] = await Promise.all([
    adapter.getRosterPersonas(),
    adapter.getHouseRules ? adapter.getHouseRules() : '',
  ]);
  const tz = timezone || (await timezoneFromSchedule(adapter)) || 'UTC';
  const day = stationDay(now, tz);

  await store.reload();
  const createdAt = now.toISOString();
  const retainedHistory = historyGenerations > 0
    ? generatedGossipHistory(store.snapshot()).flat()
    : [];
  const sessionTexts = [];
  const batchTidbits = [];
  const batchRoles = new Map();
  const seen = new Set(currentTidbits(store.snapshot()).map(tidbitKey));
  let seeded = 0;
  let rejected = 0;
  for (let i = 0; i < cap; i += 1) {
    const roles = chooseRoles(roster);
    if (!roles) {
      rejected += 1;
      continue;
    }
    const register = chooseRegister();
    const result = await generateOne({
      generate,
      roster,
      houseRules,
      roles,
      register,
      day,
      existing: [...retainedHistory, ...sessionTexts],
      sessionTidbits: sessionTexts,
      createdAt,
      log,
      sleep,
      minLength,
    });
    if (!result.ok) {
      rejected += 1;
      continue;
    }
    if (seen.has(tidbitKey(result.tidbit))) {
      rejected += 1;
      continue;
    }
    await store.mutate((state) => {
      state.tidbits.push(result.tidbit);
    });
    seen.add(tidbitKey(result.tidbit));
    batchTidbits.push(result.tidbit);
    batchRoles.set(result.tidbit.id, { roles, register });
    sessionTexts.push(result.tidbit.text);
    seeded += 1;
  }
  if (batchTidbits.length && reviewRounds > 0) {
    const { tidbits: reviewed } = await reviewGossipBatch({
      tidbits: batchTidbits,
      rolesById: batchRoles,
      roster,
      houseRules,
      day,
      reviewRounds,
      generateReview,
      log,
      minLength,
    });
    const byId = new Map(reviewed.map((t) => [t.id, t]));
    await store.mutate((state) => {
      state.tidbits = state.tidbits.map((t) => byId.get(t.id) || t);
    });
    for (let i = 0; i < sessionTexts.length; i += 1) {
      const id = batchTidbits[i]?.id;
      const updated = id ? byId.get(id) : null;
      if (updated) sessionTexts[i] = updated.text;
    }
  }
  if (sessionTexts.length || historyGenerations === 0) {
    await store.mutate((state) => {
      appendGeneratedGossipHistory(state, sessionTexts, historyGenerations);
    });
  }
  log.info?.(`[gossip] seeded ${seeded} tidbits for ${day}`);
  return { seeded, rejected, day, skipped: seeded === 0 };
}


export async function refreshGossip({
  store,
  adapter,
  generate,
  cap = 1,
  historyGenerations,
  now = new Date(),
  log = console,
  timezone,
  pickRoles,
  pickRegister,
  rumorRegisters,
  sleep,
  minLength = 20,
  reviewRounds = 0,
  generateReview,
}) {
  const chooseRoles = pickRoles || pickGossipRoles;
  const catalog = rumorRegisters ?? DEFAULT_RUMOR_REGISTERS;
  const chooseRegister = pickRegister || (() => pickRumorRegister({ catalog }));
  const [roster, houseRules] = await Promise.all([
    adapter.getRosterPersonas(),
    adapter.getHouseRules ? adapter.getHouseRules() : '',
  ]);
  if (!roster.length) {
    throw Object.assign(new Error('cannot refresh gossip without a persona roster'), { status: 503 });
  }
  const tz = timezone || (await timezoneFromSchedule(adapter)) || 'UTC';
  const day = stationDay(now, tz);
  const createdAt = now.toISOString();
  const tidbits = [];
  const batchRoles = new Map();
  const rejected = [];
  const involved = new Set();
  const targetCovered = new Set();
  const usedTargetSets = new Set();
  const requireComplete = !pickRoles;
  const maxLinks = requireComplete ? Math.max(1, roster.length * 3) : cap;
  await store.reload();
  const retainedHistory = historyGenerations > 0
    ? generatedGossipHistory(store.snapshot()).flat()
    : [];
  await store.mutate((state) => {
    state.tidbits = [];
  });
  for (let i = 0; i < maxLinks && (!requireComplete || refreshCompletenessShortfall(involved, targetCovered, roster)); i += 1) {
    const roles = pickRolesAvoidingUsedTargetSets(chooseRoles, roster, involved, targetCovered, usedTargetSets);
    if (!roles) {
      rejected.push({ reason: 'no-roles' });
      break;
    }
    const register = chooseRegister();
    const result = await generateOne({
      generate,
      roster,
      houseRules,
      roles,
      register,
      day,
      existing: [...retainedHistory, ...tidbits.map((t) => t.text)],
      sessionTidbits: tidbits.map((t) => t.text),
      createdAt,
      log,
      sleep,
      minLength,
    });
    if (!result.ok) {
      rejected.push({ reason: result.reason });
      continue;
    }
    tidbits.push(result.tidbit);
    batchRoles.set(result.tidbit.id, { roles, register });
    await store.mutate((state) => {
      state.tidbits.push(result.tidbit);
    });
    usedTargetSets.add(rumorTargetSetKey(roles.targets));
    involved.add(roles.teller.id);
    roles.hearers.forEach((p) => involved.add(p.id));
    roles.targets.forEach((p) => targetCovered.add(p.id));
  }
  const shortfall = requireComplete ? refreshCompletenessShortfall(involved, targetCovered, roster) : null;
  if (!tidbits.length || shortfall) {
    throw Object.assign(new Error('LLM produced no complete station-wide hallway chain'), {
      status: 502,
      rejected,
      involved: involved.size,
      targetCovered: targetCovered.size,
      roster: roster.length,
      participationIncomplete: shortfall?.participationIncomplete ?? involved.size < roster.length,
      targetIncomplete: shortfall?.targetIncomplete ?? targetCovered.size < roster.length,
    });
  }
  let finalTidbits = tidbits;
  if (tidbits.length && reviewRounds > 0) {
    const { tidbits: reviewed } = await reviewGossipBatch({
      tidbits,
      rolesById: batchRoles,
      roster,
      houseRules,
      day,
      reviewRounds,
      generateReview,
      log,
      minLength,
    });
    finalTidbits = reviewed;
    const byId = new Map(reviewed.map((t) => [t.id, t]));
    await store.mutate((state) => {
      state.tidbits = state.tidbits.map((t) => byId.get(t.id) || t);
    });
  }
  await store.mutate((state) => {
    appendGeneratedGossipHistory(state, finalTidbits.map((t) => t.text), historyGenerations);
    state.gossipComments = pruneGossipCommentsToTidbits(state.tidbits, state.gossipComments);
  });
  log.info?.(`[gossip] refreshed board with ${tidbits.length} linked tidbit(s) for ${day}`);
  return { refreshed: finalTidbits.length, rejected: rejected.length, day, tidbits: finalTidbits };
}

async function timezoneFromSchedule(adapter) {
  try {
    const schedule = await adapter.getSchedule();
    return schedule.timezone || '';
  } catch {
    return '';
  }
}
