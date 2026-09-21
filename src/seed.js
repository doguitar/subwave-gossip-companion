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

async function generateOne({ generate, roster, houseRules = '', roles, day, existing, previousTidbit = '', createdAt, log, sleep = defaultSleep, minLength = 20 }) {
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
        existing,
        previousTidbit,
        attempt,
      });
      const rumor = rumorFromPayload(payload);
      const check = validateRumor(rumor, { targets: roles.targets, minLength });
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

export async function seedGossip({
  store,
  adapter,
  generate,
  cap,
  now = new Date(),
  log = console,
  timezone,
  pickRoles,
  sleep,
  minLength = 20,
}) {
  const chooseRoles = pickRoles || pickGossipRoles;
  const [roster, houseRules] = await Promise.all([
    adapter.getRosterPersonas(),
    adapter.getHouseRules ? adapter.getHouseRules() : '',
  ]);
  const tz = timezone || (await timezoneFromSchedule(adapter)) || 'UTC';
  const day = stationDay(now, tz);

  await store.reload();
  const createdAt = now.toISOString();
  const seen = new Set(currentTidbits(store.snapshot()).map(tidbitKey));
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
      houseRules,
      roles,
      day,
      existing: currentTidbits(store.snapshot()).map((t) => t.text),
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
    seeded += 1;
  }
  log.info?.(`[gossip] seeded ${seeded} tidbits for ${day}`);
  return { seeded, rejected, day, skipped: seeded === 0 };
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
  sleep,
  minLength = 20,
}) {
  const chooseRoles = pickRoles || pickGossipRoles;
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
  const rejected = [];
  const involved = new Set();
  const requireComplete = !pickRoles;
  const maxLinks = requireComplete ? Math.max(1, roster.length * 3) : cap;
  await store.mutate((state) => {
    state.tidbits = [];
  });
  for (let i = 0; i < maxLinks && (!requireComplete || involved.size < roster.length); i += 1) {
    let roles = chooseRoles(roster);
    const uncovered = roster.filter((persona) => !involved.has(persona.id));
    if (roles && uncovered.length && roles.teller.id !== uncovered[0].id && !roles.hearers.some((p) => p.id === uncovered[0].id)) {
      const hearers = roles.hearers.length >= 3
        ? [...roles.hearers.slice(0, 2), uncovered[0]]
        : [...roles.hearers, uncovered[0]];
      roles = { ...roles, hearers };
    }
    if (!roles) {
      rejected.push({ reason: 'no-roles' });
      break;
    }
    const result = await generateOne({
      generate,
      roster,
      houseRules,
      roles,
      day,
      existing: tidbits.map((t) => t.text),
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
    await store.mutate((state) => {
      state.tidbits.push(result.tidbit);
    });
    involved.add(roles.teller.id);
    roles.hearers.forEach((p) => involved.add(p.id));
  }
  if (!tidbits.length || (requireComplete && involved.size < roster.length)) {
    throw Object.assign(new Error('LLM produced no complete station-wide hallway chain'), { status: 502, rejected, involved: involved.size, roster: roster.length });
  }
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
