import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GossipStore } from '../src/store.js';

export const PERSONA_A = { id: 'p_a', name: 'Alpha' };
export const PERSONA_B = { id: 'p_b', name: 'Beta' };
export const PERSONA_C = { id: 'p_c', name: 'Gamma' };

export function stubAdapter({
  show = 'Test Show',
  personas = [PERSONA_A, PERSONA_B],
  events = [],
  failSchedule = false,
  session = { messages: [] },
} = {}) {
  return {
    async getSchedule() {
      if (failSchedule) throw new Error('schedule down');
      return {
        timezone: 'UTC',
        personas: [PERSONA_A, PERSONA_B, PERSONA_C],
        shows: [
          { name: show, personaId: PERSONA_A.id, guestPersonaIds: [PERSONA_B.id] },
          { name: 'Empty Show', personaId: null, guestPersonaIds: [] },
        ],
      };
    },
    async getRosterPersonas() {
      return personas.length ? personas : [PERSONA_A, PERSONA_B, PERSONA_C];
    },
    async getShowPersonas(title) {
      const wanted = String(title || '').trim();
      if (failSchedule) return [];
      if (wanted === 'Empty Show') return [];
      if (wanted !== show) return [];
      return personas;
    },
    async getSpokenEvents() {
      return { events, cursor: events.at(-1)?.sourceEventId || null };
    },
    async getSession() {
      return session;
    },
    async getDebug() {
      return { tts: { recentCalls: [] } };
    },
  };
}

export async function tempStore(state) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gossip-'));
  const filePath = path.join(dir, 'state.json');
  const store = new GossipStore(filePath);
  await store.load();
  if (state) {
    await store.mutate((s) => {
      s.tidbits = state.tidbits || [];
    });
  }
  return { store, filePath, read: () => readFile(filePath, 'utf8').then(JSON.parse) };
}

export function tidbit(partial) {
  return {
    text: 'A only secret',
    createdAt: '2026-09-19T00:00:00.000Z',
    tellerPersonaId: PERSONA_A.id,
    hearerPersonaIds: [],
    ...partial,
  };
}
