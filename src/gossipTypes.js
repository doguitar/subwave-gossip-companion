import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { DEFAULT_RUMOR_REGISTERS } from './register.js';

export function humanizeSlug(slug) {
  return String(slug || '')
    .trim()
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function defaultGossipTypesFileEntries() {
  return DEFAULT_RUMOR_REGISTERS.map(({ id, name, guidance }) => ({
    slug: id,
    name,
    guidance,
  }));
}

export function normalizeGossipTypeEntry(raw, index) {
  const label = `gossip type entry ${index + 1}`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: `${label} must be an object` };
  }
  const slug = String(raw.slug ?? raw.id ?? '').trim();
  const guidance = String(raw.guidance ?? raw.prompt ?? raw.text ?? '').trim();
  if (!slug) return { error: `${label} is missing slug` };
  if (!guidance) return { error: `${label} "${slug}" is missing guidance` };
  const nameRaw = raw.name != null ? String(raw.name).trim() : '';
  const name = nameRaw || humanizeSlug(slug);
  return {
    register: { id: slug, name, guidance },
  };
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

export function parseGossipTypesJson(raw) {
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
    const normalized = normalizeGossipTypeEntry(entry, index);
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
  if (existsSync(typesPath)) return false;
  mkdirSync(path.dirname(typesPath), { recursive: true });
  const payload = `${JSON.stringify(defaultGossipTypesFileEntries(), null, 2)}\n`;
  writeFileSync(typesPath, payload, 'utf8');
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
