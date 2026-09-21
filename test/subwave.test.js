import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SubwaveAdapter, authorizationHeader, encodeHttpAuth } from '../src/subwave.js';

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

test('authorizationHeader is HTTP Basic of user:pass, not plaintext', () => {
  const encoded = encodeHttpAuth('admin', 'secret-pass');
  assert.equal(authorizationHeader({ apiUser: 'admin', apiPassword: 'secret-pass' }), `Basic ${encoded}`);
  assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), 'admin:secret-pass');
  assert.doesNotMatch(authorizationHeader({ apiUser: 'admin', apiPassword: 'secret-pass' }), /secret-pass/);
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
