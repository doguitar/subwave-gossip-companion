import { rumorFromPayload } from './llm.js';
import { hearerIdsForRoles, pickGossipRoles, wrapRumor } from './roles.js';
import { currentTidbits, tidbitKey } from './store.js';
import { validateRumor } from './validate.js';

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
    text: wrapRumor(roles, rumor),
    createdAt,
    tellerPersonaId: roles.teller.id,
    hearerPersonaIds: hearerIdsForRoles(roles),
  };
}

async function generateOne({ generate, roster, roles, day, existing, previousTidbit = '', createdAt, log }) {
  const maxAttempts = 3;
  let lastReason = 'empty-text';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const payload = await generate({
      personas: roster,
      day,
      roles,
      existing,
      previousTidbit,
      attempt,
    });
    const rumor = rumorFromPayload(payload);
    const check = validateRumor(rumor, { targets: roles.targets });
    if (check.ok) return { ok: true, tidbit: tidbitFromRoles(roles, rumor, createdAt) };
    lastReason = check.reason;
    log.warn?.(`[gossip] rumor rejected attempt=${attempt}/${maxAttempts}: ${check.reason}`);
  }
  return { ok: false, reason: lastReason };
}

export async function seedGossip({
  store,
  adapter,
  generate,
  cap,
  now = new Date(),
  log = console,
  timezone,
  pickRoles,
}) {
  const chooseRoles = pickRoles || pickGossipRoles;
  const roster = await adapter.getRosterPersonas();
  const tz = timezone || (await timezoneFromSchedule(adapter)) || 'UTC';
  const day = stationDay(now, tz);

  return store.mutate(async (state) => {
    const createdAt = now.toISOString();
    const seen = new Set(currentTidbits(state).map(tidbitKey));
    let seeded = 0;
    let rejected = 0;
    for (let i = 0; i < cap; i += 1) {
      const roles = chooseRoles(roster);
      if (!roles) {
        rejected += 1;
        continue;
      }
      const result = await generateOne({
        generate,
        roster,
        roles,
        day,
        existing: currentTidbits(state).map((t) => t.text),
        createdAt,
        log,
      });
      if (!result.ok) {
        rejected += 1;
        continue;
      }
      if (seen.has(tidbitKey(result.tidbit))) {
        rejected += 1;
        continue;
      }
      state.tidbits.push(result.tidbit);
      seen.add(tidbitKey(result.tidbit));
      seeded += 1;
    }
    log.info?.(`[gossip] seeded ${seeded} tidbits for ${day}`);
    return { seeded, rejected, day, skipped: seeded === 0 };
  });
}

function chainedRoles(roster, previous) {
  const priorHearers = previous?.hearers || [];
  const priorHearerIds = new Set(priorHearers.map((p) => p.id));
  const tellerPool = priorHearers.filter((p) => p?.id && p.id !== previous.teller.id);
  if (!tellerPool.length) return null;
  const teller = tellerPool[Math.floor(Math.random() * tellerPool.length)];
  const candidates = roster.filter((p) => p.id !== previous.teller.id && p.id !== teller.id && !priorHearerIds.has(p.id));
  const shuffled = candidates.sort(() => Math.random() - 0.5);
  const count = Math.min(3, shuffled.length);
  const hearers = shuffled.slice(0, Math.max(1, Math.min(count, shuffled.length)));
  return { teller, hearers, targets: [] };
}

export async function refreshGossip({
  store,
  adapter,
  generate,
  cap = 1,
  now = new Date(),
  log = console,
  timezone,
  pickRoles,
}) {
  const chooseRoles = pickRoles || pickGossipRoles;
  const roster = await adapter.getRosterPersonas();
  if (!roster.length) {
    throw Object.assign(new Error('cannot refresh gossip without a persona roster'), { status: 503 });
  }
  const tz = timezone || (await timezoneFromSchedule(adapter)) || 'UTC';
  const day = stationDay(now, tz);
  const createdAt = now.toISOString();
  const tidbits = [];
  const rejected = [];
  const involved = new Set();
  let previous;
  let previousTidbit = '';
  const requireComplete = !pickRoles;
  const maxLinks = requireComplete ? Math.max(1, roster.length * 3) : cap;
  for (let i = 0; i < maxLinks && (!requireComplete || involved.size < roster.length); i += 1) {
    let roles = previous && requireComplete ? chainedRoles(roster, previous) : chooseRoles(roster);
    if (requireComplete && !previous && roles && !roles.hearers.length) {
      const firstHearer = roster.find((p) => p.id !== roles.teller.id);
      roles = { ...roles, hearers: firstHearer ? [firstHearer] : [] };
    }
    if (!roles) {
      rejected.push({ reason: 'no-roles' });
      break;
    }
    const result = await generateOne({
      generate,
      roster,
      roles,
      day,
      existing: tidbits.map((t) => t.text),
      previousTidbit,
      createdAt,
      log,
    });
    if (!result.ok) {
      rejected.push({ reason: result.reason });
      continue;
    }
    tidbits.push(result.tidbit);
    involved.add(roles.teller.id);
    roles.hearers.forEach((p) => involved.add(p.id));
    previous = roles;
    previousTidbit = result.tidbit.text;
  }
  if (!tidbits.length || (requireComplete && involved.size < roster.length)) {
    throw Object.assign(new Error('LLM produced no complete station-wide hallway chain'), { status: 502, rejected, involved: involved.size, roster: roster.length });
  }
  await store.mutate((state) => {
    state.tidbits = tidbits;
  });
  log.info?.(`[gossip] refreshed board with ${tidbits.length} linked tidbit(s) for ${day}`);
  return { refreshed: tidbits.length, rejected: rejected.length, day, tidbits };
}

async function timezoneFromSchedule(adapter) {
  try {
    const schedule = await adapter.getSchedule();
    return schedule.timezone || '';
  } catch {
    return '';
  }
}
