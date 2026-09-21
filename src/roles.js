function randInt(rng, min, maxInclusive) {
  return min + Math.floor(rng() * (maxInclusive - min + 1));
}

function shuffle(list, rng) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function joinNames(names) {
  if (!names.length) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

export function pickGossipRoles(personas, { rng = Math.random, hearerMax = 3, targetMax = 2 } = {}) {
  const roster = (personas || []).filter((p) => p && p.id);
  if (!roster.length) return null;
  const shuffled = shuffle(roster, rng);
  const teller = shuffled[0];
  const unused = shuffled.slice(1);
  const hearerCount = randInt(rng, 0, Math.min(hearerMax, unused.length));
  const hearers = unused.slice(0, hearerCount);
  const leftover = unused.slice(hearerCount);
  const targetCount = randInt(rng, 0, Math.min(targetMax, leftover.length));
  const targets = leftover.slice(0, targetCount);
  return { teller, hearers, targets };
}

export function wrapRumor(roles, rumor) {
  const quoted = String(rumor || '').trim().replace(/^["“]|["”]$/g, '').replace(/\s+/g, ' ').trim();
  const tellerName = roles.teller.name;
  if (!roles.hearers.length) return `${tellerName} said on air, "${quoted}"`;
  return `${tellerName} told ${joinNames(roles.hearers.map((p) => p.name))}, "${quoted}"`;
}

export function hearerIdsForRoles(roles) {
  return roles.hearers.length ? roles.hearers.map((p) => p.id) : null;
}

export function personaSoul(persona) {
  return String(
    persona?.soul
    || persona?.soulMd
    || persona?.soulText
    || persona?.system
    || persona?.systemPrompt
    || persona?.prompt
    || persona?.tagline
    || '',
  ).trim();
}
