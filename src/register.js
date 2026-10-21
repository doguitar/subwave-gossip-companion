import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGED_GOSSIP_TYPES_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../gossip-types.json',
);

export function readPackagedGossipTypes() {
  return JSON.parse(readFileSync(PACKAGED_GOSSIP_TYPES_PATH, 'utf8'));
}

export const DEFAULT_RUMOR_REGISTERS = readPackagedGossipTypes().map((entry) => {
  const register = {
    id: String(entry.slug || entry.id || '').trim(),
    name: String(entry.name || entry.slug || '').trim(),
    guidance: String(entry.guidance || '').trim(),
  };
  if (entry.targetCount != null) register.targetCount = entry.targetCount;
  return register;
});

/** @deprecated Use loaded config catalog or DEFAULT_RUMOR_REGISTERS in tests. */
export const RUMOR_REGISTERS = DEFAULT_RUMOR_REGISTERS;

export function rumorRegistersForTargetCount(catalog, targetCount) {
  const list = catalog?.length ? catalog : DEFAULT_RUMOR_REGISTERS;
  return list.filter(
    (register) => register.targetCount == null || register.targetCount === targetCount,
  );
}

export function pickRumorRegister({
  catalog = DEFAULT_RUMOR_REGISTERS,
  targetCount,
  rng = Math.random,
} = {}) {
  const eligible = targetCount == null
    ? (catalog?.length ? catalog : DEFAULT_RUMOR_REGISTERS)
    : rumorRegistersForTargetCount(catalog, targetCount);
  if (!eligible.length) return null;
  const index = Math.floor(rng() * eligible.length);
  return eligible[Math.min(index, eligible.length - 1)];
}
