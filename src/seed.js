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
import { formatRumorForOperationalLog } from './log.js';
import { reviewGossipBatch } from './review.js';

let generationQueue = Promise.resolve();

function isShutdownSignal(signal) {
  const reason = signal?.reason;
  return reason === 'shutdown' || reason?.reason === 'shutdown';
}

function abortError(signal) {
  if (isShutdownSignal(signal)) {
    return Object.assign(new Error('shutting down'), { name: 'AbortError', reason: 'shutdown', status: 503 });
  }
  return Object.assign(new Error('gossip generation aborted'), { name: 'AbortError' });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

async function withSignal(promise, signal) {
  throwIfAborted(signal);
  const work = Promise.resolve(promise);
  if (!signal) return work;
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortError(signal));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } catch (err) {
    if (signal.aborted) throw abortError(signal);
    throw err;
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function serializeGeneration(operation, signal) {
  const previous = generationQueue;
  let release;
  generationQueue = new Promise((resolve) => {
    release = resolve;
  });
  return previous
    .catch(() => {})
    .then(async () => {
      throwIfAborted(signal);
      return operation();
    })
    .finally(release);
}

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

function tidbitFromRoles(roles, rumor, createdAt, canonicalAnchors = {}) {
  const id = randomUUID();
  return {
    id,
    threadId: id,
    text: wrapRumor(roles, rumor),
    createdAt,
    tellerPersonaId: roles.teller.id,
    hearerPersonaIds: hearerIdsForRoles(roles),
    canonicalSubjectPersonaId: roles.targets[0]?.id || '',
    canonicalTargetPersonaIds: roles.targets.map((target) => target.id),
    canonicalAnchors: {
      location: canonicalAnchors.location || '',
      ownerPersonaId: canonicalAnchors.ownerPersonaId || '',
      props: Array.isArray(canonicalAnchors.props) ? canonicalAnchors.props : [],
    },
    toldAt: [],
  };
}

export const RATE_LIMIT_ATTEMPTS = 4;
export const RATE_LIMIT_DEADLINE_MS = 60_000;

export function rateLimitDelayMs({
  attempt,
  retryAfterMs,
  elapsedMs = 0,
  deadlineMs = RATE_LIMIT_DEADLINE_MS,
  random = Math.random,
}) {
  const remaining = deadlineMs - elapsedMs;
  if (remaining <= 0) return null;
  const exponential = Math.min(30_000, 1_000 * (2 ** Math.min(Math.max(attempt, 1) - 1, 4)));
  const jittered = Math.round(exponential * (0.5 + random() * 0.5));
  const requested = Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : jittered;
  if (requested > remaining) return null;
  return requested;
}

function rateLimitExhausted() {
  return Object.assign(new Error('LLM rate limit retries exhausted'), { status: 429, code: 'RATE_LIMIT' });
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
  lifecycleId,
  createdAt,
  log,
  sleep = defaultSleep,
  minLength = 20,
  signal,
  now = Date.now,
  random = Math.random,
}) {
  const maxAttempts = 3;
  let lastReason = 'empty-text';
  let attempt = 0;
  let rateLimits = 0;
  let rateLimitStartedAt = 0;
  while (attempt < maxAttempts) {
    throwIfAborted(signal);
    attempt += 1;
    try {
      const payload = await withSignal(generate({
        personas: roster,
        houseRules,
        day,
        roles,
        register,
        existing,
        sessionTidbits,
        attempt,
        lifecycleId,
        signal,
      }), signal);
      const rumor = rumorFromPayload(payload);
      const anchors = payload?.anchors || (Array.isArray(payload?.items) ? payload.items[0]?.anchors : null) || {};
      const check = validateRumor(rumor, { targets: roles.targets, minLength, maxLength: 240 });
      if (check.ok) {
        const tidbit = tidbitFromRoles(roles, rumor, createdAt, anchors);
        log.info?.(
          `[gossip] tidbit accepted id=${tidbit.id} text=${formatRumorForOperationalLog(tidbit.text)}`,
        );
        return { ok: true, tidbit };
      }
      lastReason = check.reason;
      log.warn?.(`[gossip] rumor rejected attempt=${attempt}/${maxAttempts}: ${check.reason}`);
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      if (err?.status === 429) {
        rateLimits += 1;
        if (!rateLimitStartedAt) rateLimitStartedAt = now();
        const delay = rateLimits >= RATE_LIMIT_ATTEMPTS
          ? null
          : rateLimitDelayMs({
            attempt: rateLimits,
            retryAfterMs: err.retryAfterMs,
            elapsedMs: now() - rateLimitStartedAt,
            random,
          });
        if (delay == null) throw rateLimitExhausted();
        log.warn?.(`[gossip] LLM rate limited; retrying in ${delay}ms`);
        await withSignal(sleep(delay), signal);
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
const ROLE_REGISTER_PICK_ATTEMPTS = 24;

function pickRolesAndRegister(chooseRoles, roster, chooseRegister) {
  for (let attempt = 0; attempt < ROLE_REGISTER_PICK_ATTEMPTS; attempt += 1) {
    const roles = rolesFromRoster(chooseRoles(roster), roster);
    if (!roles) return null;
    const register = chooseRegister(roles);
    if (register) return { roles, register };
  }
  return null;
}

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

function pickRolesAvoidingUsedTargetSets(chooseRoles, roster, involved, targetCovered, usedTargetSets, recentTargetSets = new Set()) {
  let roles = null;
  for (let attempt = 0; attempt < TARGET_SET_PICK_ATTEMPTS; attempt += 1) {
    roles = applyUncoveredHearerBias(chooseRoles(roster), roster, involved);
    roles = applyUncoveredTargetBias(roles, roster, targetCovered);
    if (!roles) return null;
    const key = rumorTargetSetKey(roles.targets);
    if (!usedTargetSets.has(key) && !recentTargetSets.has(key)) return rolesFromRoster(roles, roster);
  }
  return rolesFromRoster(roles, roster);
}

function recentSelectionPenalty(tidbits) {
  const targetSets = new Set();
  const props = new Set();
  for (const tidbit of tidbits) {
    targetSets.add((tidbit.canonicalTargetPersonaIds || []).slice().sort().join(','));
    for (const prop of tidbit.canonicalAnchors?.props || []) props.add(prop.toLowerCase());
  }
  return { targetSets, props };
}

function rolesFromRoster(roles, roster) {
  if (!roles) return roles;
  const byId = new Map(roster.map((persona) => [persona.id, persona]));
  const swap = (persona) => byId.get(persona?.id) || persona;
  return {
    ...roles,
    teller: swap(roles.teller),
    hearers: (roles.hearers || []).map(swap),
    targets: (roles.targets || []).map(swap),
  };
}

function rosterWithSummaries(roster, summarizeSouls) {
  if (!summarizeSouls) return Promise.resolve(roster);
  return Promise.resolve(summarizeSouls(roster)).then((summaries) => {
    const byId = new Map((summaries || []).map((item) => [item.id, String(item.summary || '').trim()]));
    return roster.map((persona) => {
      const rumorSummary = byId.get(persona.id);
      return rumorSummary ? { ...persona, rumorSummary } : persona;
    });
  });
}

function refreshCompletenessShortfall(involved, targetCovered, roster) {
  const participationIncomplete = involved.size < roster.length;
  const targetIncomplete = targetCovered.size < roster.length;
  if (!participationIncomplete && !targetIncomplete) return null;
  return { participationIncomplete, targetIncomplete };
}

export async function seedGossip({
  signal,
  ...options
}) {
  return serializeGeneration(() => seedGossipOperation(options, signal), signal);
}

async function seedGossipOperation({
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
  summarizeSouls,
  summarizeHouseRules,
}, signal) {
  throwIfAborted(signal);
  const lifecycleId = randomUUID();
  const startedAt = Date.now();
  const chooseRoles = pickRoles || pickGossipRoles;
  const catalog = rumorRegisters ?? DEFAULT_RUMOR_REGISTERS;
  const chooseRegister = pickRegister
    ? () => pickRegister()
    : (roles) => pickRumorRegister({ catalog, targetCount: roles.targets.length });
  const [loadedRoster, loadedHouseRules] = await Promise.all([
    adapter.getRosterPersonas(),
    adapter.getHouseRules ? adapter.getHouseRules() : '',
  ]);
  const roster = await rosterWithSummaries(loadedRoster, summarizeSouls);
  const houseRules = summarizeHouseRules ? await summarizeHouseRules(loadedHouseRules) : loadedHouseRules;
  throwIfAborted(signal);
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
  let review = { accepted: 0, rejected: 0, stale: 0 };
  let reviewedById = new Map();
  const seen = new Set(currentTidbits(store.snapshot()).map(tidbitKey));
  let seeded = 0;
  let rejected = 0;
  for (let i = 0; i < cap; i += 1) {
    const picked = pickRolesAndRegister(chooseRoles, roster, chooseRegister);
    if (!picked) {
      rejected += 1;
      continue;
    }
    const { roles, register } = picked;
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
      lifecycleId,
    });
    if (!result.ok) {
      rejected += 1;
      continue;
    }
    if (seen.has(tidbitKey(result.tidbit))) {
      rejected += 1;
      continue;
    }
    seen.add(tidbitKey(result.tidbit));
    batchTidbits.push(result.tidbit);
    batchRoles.set(result.tidbit.id, { roles, register });
    sessionTexts.push(result.tidbit.text);
    seeded += 1;
  }
  if (batchTidbits.length && reviewRounds > 0) {
    const result = await reviewGossipBatch({
      tidbits: batchTidbits,
      rolesById: batchRoles,
      roster,
      houseRules,
      day,
      reviewRounds,
      generateReview,
      log,
      minLength,
      lifecycleId,
    });
    const { tidbits: reviewed } = result;
    review = result;
    const byId = new Map(reviewed.map((t) => [t.id, t]));
    reviewedById = byId;
    for (let i = 0; i < sessionTexts.length; i += 1) {
      const id = batchTidbits[i]?.id;
      const updated = id ? byId.get(id) : null;
      if (updated) sessionTexts[i] = updated.text;
    }
  }
  throwIfAborted(signal);
  if (batchTidbits.length || sessionTexts.length || historyGenerations === 0) {
    await store.mutate((state) => {
      state.tidbits.push(...batchTidbits.map((tidbit) => reviewedById.get(tidbit.id) || tidbit));
      appendGeneratedGossipHistory(state, sessionTexts, historyGenerations);
    });
  }
  log.info?.(`[gossip] lifecycle ${JSON.stringify({ version: 1, lifecycleId, kind: 'seed', stage: 'complete', elapsedMs: Date.now() - startedAt, seeded, rejected, review })}`);
  return { seeded, rejected, day, skipped: seeded === 0, review };
}


export async function refreshGossip({
  signal,
  ...options
}) {
  return serializeGeneration(() => refreshGossipOperation(options, signal), signal);
}

async function refreshGossipOperation({
  store,
  adapter,
  generate,
  cap = 1,
  strictCap = false,
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
  summarizeSouls,
  summarizeHouseRules,
}, signal) {
  throwIfAborted(signal);
  const lifecycleId = randomUUID();
  const startedAt = Date.now();
  try {
    return await runRefreshGossip({
      store,
      adapter,
      generate,
      cap,
      strictCap,
      historyGenerations,
      now,
      log,
      timezone,
      pickRoles,
      pickRegister,
      rumorRegisters,
      sleep,
      minLength,
      reviewRounds,
      generateReview,
      summarizeSouls,
      summarizeHouseRules,
    }, signal, lifecycleId, startedAt);
  } catch (err) {
    if (err?.name === 'AbortError' && err.reason === 'shutdown') {
      log.info?.(`[gossip] lifecycle ${JSON.stringify({ version: 1, lifecycleId, kind: 'refresh', stage: 'aborted', reason: 'shutdown' })}`);
    }
    throw err;
  }
}

async function runRefreshGossip({
  store,
  adapter,
  generate,
  cap = 1,
  strictCap = false,
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
  summarizeSouls,
  summarizeHouseRules,
}, signal, lifecycleId, startedAt) {
  const chooseRoles = pickRoles || pickGossipRoles;
  const catalog = rumorRegisters ?? DEFAULT_RUMOR_REGISTERS;
  const chooseRegister = pickRegister
    ? () => pickRegister()
    : (roles) => pickRumorRegister({ catalog, targetCount: roles.targets.length });
  const [loadedRoster, loadedHouseRules] = await Promise.all([
    withSignal(adapter.getRosterPersonas({ signal }), signal),
    adapter.getHouseRules ? withSignal(adapter.getHouseRules({ signal }), signal) : '',
  ]);
  throwIfAborted(signal);
  const roster = await withSignal(rosterWithSummaries(
    loadedRoster,
    summarizeSouls ? (personas) => summarizeSouls(personas, { signal }) : null,
  ), signal);
  throwIfAborted(signal);
  const houseRules = summarizeHouseRules
    ? await withSignal(Promise.resolve(summarizeHouseRules(loadedHouseRules, { signal })), signal)
    : loadedHouseRules;
  throwIfAborted(signal);
  if (!roster.length) {
    throw Object.assign(new Error('cannot refresh gossip without a persona roster'), { status: 503 });
  }
  const tz = timezone || (await timezoneFromSchedule(adapter, signal)) || 'UTC';
  const day = stationDay(now, tz);
  const createdAt = now.toISOString();
  const tidbits = [];
  const batchRoles = new Map();
  const rejected = [];
  const involved = new Set();
  const targetCovered = new Set();
  const usedTargetSets = new Set();
  const requireComplete = !pickRoles;
  const maxLinks = strictCap || !requireComplete ? cap : Math.max(1, roster.length * 3);
  throwIfAborted(signal);
  await store.reload();
  throwIfAborted(signal);
  const baselineIds = currentTidbits(store.snapshot()).map((tidbit) => tidbit.id);
  const baselineRevision = store.snapshot().boardRevision;
  const penalties = recentSelectionPenalty(currentTidbits(store.snapshot()));
  const retainedHistory = historyGenerations > 0
    ? generatedGossipHistory(store.snapshot()).flat()
    : [];
  for (let i = 0; i < maxLinks && (!requireComplete || refreshCompletenessShortfall(involved, targetCovered, roster)); i += 1) {
    throwIfAborted(signal);
    let roles = null;
    let register = null;
    for (let pickAttempt = 0; pickAttempt < ROLE_REGISTER_PICK_ATTEMPTS; pickAttempt += 1) {
      roles = pickRolesAvoidingUsedTargetSets(chooseRoles, roster, involved, targetCovered, usedTargetSets, penalties.targetSets);
      if (!roles) break;
      register = chooseRegister(roles);
      if (register) break;
    }
    if (!roles) {
      rejected.push({ reason: 'no-roles' });
      break;
    }
    if (!register) {
      rejected.push({ reason: 'no-register' });
      continue;
    }
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
      lifecycleId,
      signal,
    });
    if (!result.ok) {
      rejected.push({ reason: result.reason });
      continue;
    }
    if (result.tidbit.canonicalAnchors.props.some((prop) => penalties.props.has(prop.toLowerCase()))) {
      rejected.push({ reason: 'recent-prop' });
      continue;
    }
    tidbits.push(result.tidbit);
    batchRoles.set(result.tidbit.id, { roles, register });
    usedTargetSets.add(rumorTargetSetKey(roles.targets));
    involved.add(roles.teller.id);
    roles.hearers.forEach((p) => involved.add(p.id));
    roles.targets.forEach((p) => targetCovered.add(p.id));
  }
  const shortfall = requireComplete && !strictCap
    ? refreshCompletenessShortfall(involved, targetCovered, roster)
    : null;
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
  let review = { accepted: 0, rejected: 0, stale: 0 };
  if (tidbits.length && reviewRounds > 0) {
    throwIfAborted(signal);
    const result = await reviewGossipBatch({
      tidbits,
      rolesById: batchRoles,
      roster,
      houseRules,
      day,
      reviewRounds,
      generateReview,
      log,
      minLength,
      lifecycleId,
      signal,
    });
    finalTidbits = result.tidbits;
    review = result;
  }
  throwIfAborted(signal);
  await store.mutate((state) => {
    const committedIds = new Set(currentTidbits(state).map((tidbit) => tidbit.id));
    if (state.boardRevision !== baselineRevision || baselineIds.some((id) => !committedIds.has(id))) {
      throw Object.assign(new Error(`another refresh already committed ${store.configuredPath()}`), { status: 409 });
    }
    state.boardRevision = baselineRevision + 1;
    const latestById = new Map(currentTidbits(state).map((tidbit) => [tidbit.id, tidbit]));
    state.tidbits = finalTidbits.map((tidbit) => {
      const latest = latestById.get(tidbit.id);
      if (!latest?.toldAt?.length) return tidbit;
      const toldAt = [...new Set([...(tidbit.toldAt || []), ...latest.toldAt])].sort();
      return { ...tidbit, toldAt };
    });
    appendGeneratedGossipHistory(state, state.tidbits.map((tidbit) => tidbit.text), historyGenerations);
    state.gossipComments = pruneGossipCommentsToTidbits(state.tidbits, state.gossipComments);
  });
  log.info?.(`[gossip] lifecycle ${JSON.stringify({ version: 1, lifecycleId, kind: 'refresh', stage: 'complete', elapsedMs: Date.now() - startedAt, refreshed: finalTidbits.length, rejected: rejected.length, review })}`);
  return { refreshed: finalTidbits.length, rejected: rejected.length, day, tidbits: finalTidbits, review };
}

async function timezoneFromSchedule(adapter, signal) {
  try {
    const schedule = await withSignal(adapter.getSchedule({ signal }), signal);
    return schedule.timezone || '';
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError') throw err;
    return '';
  }
}
