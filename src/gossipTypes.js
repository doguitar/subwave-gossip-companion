import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { PACKAGED_GOSSIP_TYPES_PATH, readPackagedGossipTypes } from './register.js';

export function humanizeSlug(slug) {
  return String(slug || '')
    .trim()
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function defaultGossipTypesFileEntries() {
  return readPackagedGossipTypes();
}

export const DEFAULT_GOSSIP_TARGET_MAX = 2;

export function validateGossipTypeTargetCount(raw, slug, { targetMax = DEFAULT_GOSSIP_TARGET_MAX } = {}) {
  if (raw.targetCount == null && raw.rumorTargetCount == null) return {};
  const value = raw.targetCount ?? raw.rumorTargetCount;
  if (typeof value === 'boolean' || !Number.isInteger(value) || value < 0) {
    return { error: `gossip type "${slug}" targetCount must be a non-negative integer` };
  }
  if (value > targetMax) {
    return {
      error: `gossip type "${slug}" targetCount ${value} exceeds the maximum rumor-target count (${targetMax})`,
    };
  }
  return { targetCount: value };
}

export function normalizeGossipTypeEntry(raw, index, { targetMax = DEFAULT_GOSSIP_TARGET_MAX } = {}) {
  const label = `gossip type entry ${index + 1}`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: `${label} must be an object` };
  }
  const slug = String(raw.slug ?? raw.id ?? '').trim();
  const guidance = String(raw.guidance ?? raw.prompt ?? raw.text ?? '').trim();
  if (!slug) return { error: `${label} is missing slug` };
  if (!guidance) return { error: `${label} "${slug}" is missing guidance` };
  const targetResult = validateGossipTypeTargetCount(raw, slug, { targetMax });
  if (targetResult.error) return { error: targetResult.error };
  const nameRaw = raw.name != null ? String(raw.name).trim() : '';
  const name = nameRaw || humanizeSlug(slug);
  const register = { id: slug, name, guidance };
  if (targetResult.targetCount != null) register.targetCount = targetResult.targetCount;
  return { register };
}

export function validateGossipTypesCatalog(registers) {
  const errors = [];
  if (!Array.isArray(registers) || registers.length === 0) {
    errors.push('gossip types catalog must contain at least one entry');
    return errors;
  }
  const seen = new Set();
  for (const register of registers) {
    const slug = register?.id;
    if (!slug) continue;
    if (seen.has(slug)) {
      errors.push(`duplicate gossip type slug: ${slug}`);
    }
    seen.add(slug);
  }
  return errors;
}

export function parseGossipTypesJson(raw, { targetMax = DEFAULT_GOSSIP_TARGET_MAX } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { errors: [`gossip types file is not valid JSON: ${err.message}`] };
  }
  const entries = Array.isArray(parsed) ? parsed : parsed?.types;
  if (!Array.isArray(entries)) {
    return { errors: ['gossip types file must be a JSON array or an object with a types array'] };
  }
  const errors = [];
  const registers = [];
  entries.forEach((entry, index) => {
    const normalized = normalizeGossipTypeEntry(entry, index, { targetMax });
    if (normalized.error) {
      errors.push(normalized.error);
      return;
    }
    registers.push(normalized.register);
  });
  errors.push(...validateGossipTypesCatalog(registers));
  if (errors.length) return { errors };
  return { registers };
}

export function ensureGossipTypesFile(typesPath) {
  if (existsSync(typesPath)) {
    const existing = readFileSync(typesPath, 'utf8');
    if (existing.trim()) return false;
  }
  mkdirSync(path.dirname(typesPath), { recursive: true });
  const payload = readFileSync(PACKAGED_GOSSIP_TYPES_PATH, 'utf8');
  writeFileSync(typesPath, payload.endsWith('\n') ? payload : `${payload}\n`, 'utf8');
  return true;
}

export function loadGossipTypesFromPath(typesPath) {
  ensureGossipTypesFile(typesPath);
  let raw;
  try {
    raw = readFileSync(typesPath, 'utf8');
  } catch (err) {
    return { errors: [`cannot read gossip types file: ${err.message}`] };
  }
  const { registers, errors } = parseGossipTypesJson(raw);
  if (errors?.length) return { errors, typesPath };
  return { registers, typesPath };
}
