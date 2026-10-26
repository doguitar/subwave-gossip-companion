import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SubwaveAdapter, authorizationHeader, encodeHttpAuth, eventsFromSession } from '../src/subwave.js';

const schedule = {
  personas: [
    { id: 'p_a', name: 'Alpha' },
    { id: 'p_b', name: 'Beta' },
  ],
  shows: [
    { name: ' Test Show ', personaId: 'p_a', guestPersonaIds: ['p_b', 'p_a'] },
  ],
};

test('getShowPersonas exact-trims title and dedupes persona ids', async () => {
  const adapter = new SubwaveAdapter({
    apiUrl: 'http://subwave.test',
    apiToken: 'token',
    fetchImpl: async () => ({ ok: true, json: async () => schedule }),
    log: { warn() {} },
  });
  const personas = await adapter.getShowPersonas('Test Show');
  assert.deepEqual(personas.map((p) => ({ id: p.id, name: p.name })), [
    { id: 'p_a', name: 'Alpha' },
    { id: 'p_b', name: 'Beta' },
  ]);
  assert.deepEqual(await adapter.getShowPersonas('test show'), []);
});

test('getShowPersonas rethrows when schedule HTTP fails', async () => {
  const adapter = new SubwaveAdapter({
    apiUrl: 'http://subwave.test',
    apiToken: 'token',
    fetchImpl: async () => ({ ok: false, status: 502 }),
    log: { warn() {} },
  });
  await assert.rejects(adapter.getShowPersonas('Test Show'), (err) => {
    assert.equal(err.status, 502);
    return true;
  });
});

test('getShowPersonas uses 503 when schedule error has no HTTP status', async () => {
  const adapter = new SubwaveAdapter({
    apiUrl: 'http://subwave.test',
    apiToken: 'token',
    fetchImpl: async () => {
      throw new Error('network down');
    },
    log: { warn() {} },
  });
  await assert.rejects(adapter.getShowPersonas('Test Show'), (err) => {
    assert.equal(err.status, 503);
    return true;
  });
});

test('authorizationHeader is HTTP Basic of user:pass, not plaintext', () => {
  const encoded = encodeHttpAuth('admin', 'secret-pass');
  assert.equal(authorizationHeader({ apiUser: 'admin', apiPassword: 'secret-pass' }), `Basic ${encoded}`);
  assert.equal(authorizationHeader({ apiToken: 'admin:secret-pass' }), `Basic ${encoded}`);
  assert.equal(authorizationHeader({ apiToken: encoded }), `Basic ${encoded}`);
  assert.equal(authorizationHeader({ apiToken: encoded, apiUser: 'other', apiPassword: 'nope' }), `Basic ${encoded}`);
  assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), 'admin:secret-pass');
  assert.doesNotMatch(authorizationHeader({ apiToken: 'admin:secret-pass' }), /secret-pass|Bearer/);
});

test('getRosterPersonas prefers admin /settings souls over public schedule', async () => {
  const adapter = new SubwaveAdapter({
    apiUrl: 'http://subwave.test',
    apiUser: 'admin',
    apiPassword: 'secret-pass',
    fetchImpl: async (url) => {
      const path = String(url);
      if (path.includes('/settings')) {
        return {
          ok: true,
          json: async () => ({
            values: {
              djHouseRules: 'Adult language allowed after 10 PM.',
              personas: [
                { id: 'p_a', name: 'Alpha', tagline: 'First chair', soul: 'Dry, short sentences. Notices clocks.', tts: { secret: true } },
              ],
            },
          }),
        };
      }
      return { ok: true, json: async () => schedule };
    },
    log: { warn() {} },
  });
  const rules = await adapter.getHouseRules();
  assert.equal(rules, 'Adult language allowed after 10 PM.');
});

test('getRosterPersonas prefers admin /settings souls over public schedule', async () => {
  const adapter = new SubwaveAdapter({
    apiUrl: 'http://subwave.test',
    apiUser: 'admin',
    apiPassword: 'secret-pass',
    fetchImpl: async (url) => {
      const path = String(url);
      if (path.includes('/settings')) {
        return {
          ok: true,
          json: async () => ({
            values: {
              personas: [
                { id: 'p_a', name: 'Alpha', tagline: 'First chair', soul: 'Dry, short sentences. Notices clocks.', tts: { secret: true } },
              ],
            },
          }),
        };
      }
      return { ok: true, json: async () => schedule };
    },
    log: { warn() {} },
  });
  const roster = await adapter.getRosterPersonas();
  assert.equal(roster.length, 1);
  assert.equal(roster[0].soul, 'Dry, short sentences. Notices clocks.');
  assert.equal(roster[0].tagline, 'First chair');
  assert.equal(roster[0].tts, undefined);
});

test('getDebug sends Basic auth and reads tts.recentCalls', async () => {
  const adapter = new SubwaveAdapter({
    apiUrl: 'http://subwave.test',
    apiUser: 'admin',
    apiPassword: 'secret-pass',
    fetchImpl: async (_url, opts) => {
      assert.equal(opts.headers.Authorization, `Basic ${encodeHttpAuth('admin', 'secret-pass')}`);
      return {
        ok: true,
        json: async () => ({
          tts: {
            recentCalls: [
              { kind: 'station-gossip', text: 'Word is the cart skipped', persona: 'Reed Silver', at: '2026-09-19T17:01:30.340Z' },
            ],
          },
        }),
      };
    },
    log: { warn() {} },
  });
  const debug = await adapter.getDebug();
  assert.equal(debug.tts.recentCalls[0].persona, 'Reed Silver');
});

test('spoken session events keep an explicit actor id', () => {
  const { events } = eventsFromSession({
    messages: [
      {
        id: 'evt-1',
        kind: 'station-gossip',
        text: 'Word is the cart skipped',
        meta: {
          spokenAt: '2026-09-19T12:00:00.000Z',
          actor_persona_id: 'persona-a',
          show: 'Test Show',
        },
      },
      {
        id: 'evt-2',
        kind: 'station-gossip',
        text: 'No actor on this one',
        personaId: 'should-not-copy',
        meta: { spokenAt: '2026-09-19T12:05:00.000Z' },
      },
    ],
  });
  assert.equal(events[0].actorPersonaId, 'persona-a');
  assert.equal(events[0].show, 'Test Show');
  assert.equal(events[1].actorPersonaId, undefined);
});

test('session fallback keeps a known cursor and does not replay an unknown one', () => {
  const session = {
    messages: [
      { id: 'e1', kind: 'gossip-spoken', text: 'first', meta: { spokenAt: '2026-09-19T10:00:00.000Z' } },
      { id: 'e2', kind: 'gossip-spoken', text: 'second', meta: { spokenAt: '2026-09-19T11:00:00.000Z' } },
    ],
  };
  const continued = eventsFromSession(session, 'e1');
  assert.deepEqual(continued.events.map((event) => event.sourceEventId), ['e2']);
  assert.equal(continued.cursorStatus, 'advanced');
  const unknown = eventsFromSession(session, 'pruned');
  assert.deepEqual(unknown.events, []);
  assert.equal(unknown.cursor, 'e2');
  assert.equal(unknown.cursorStatus, 'unknown');
});
