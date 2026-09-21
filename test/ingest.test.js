import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ingestSpoken } from '../src/ingest.js';
import { createServer } from '../src/server.js';
import { PERSONA_A, PERSONA_B, PERSONA_C, stubAdapter, tempStore, tidbit } from './helpers.js';

test('ingest sets hearerPersonaIds to null and is idempotent', async () => {
  const event = {
    spokenText: 'Booth whisper',
    spokenAt: '2026-09-19T10:00:00.000Z',
  };
  const { store, read } = await tempStore({
    tidbits: [tidbit({ text: 'Booth whisper', tellerPersonaId: PERSONA_A.id, hearerPersonaIds: [] })],
  });
  const adapter = stubAdapter({
    personas: [PERSONA_A, PERSONA_B, PERSONA_C],
    events: [event],
  });

  const first = await ingestSpoken({ store, adapter, log: { info() {}, warn() {} } });
  assert.equal(first.ingested, 1);
  const second = await ingestSpoken({ store, adapter, log: { info() {}, warn() {} } });
  assert.equal(second.ingested, 0);

  const state = await read();
  assert.deepEqual(Object.keys(state), ['tidbits']);
  assert.equal(state.tidbits[0].hearerPersonaIds, null);

  const server = createServer({
    store,
    adapter: stubAdapter({ show: 'Gamma Hour', personas: [PERSONA_C] }),
    config: { host: '127.0.0.1', port: 0, feedBaseUrl: '' },
    log: { warn() {}, error() {}, info() {} },
    watcher: { afterSkillFetch() {} },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/gossip.rss?show=${encodeURIComponent('Gamma Hour')}`);
  const xml = await res.text();
  server.close();
  assert.match(xml, /Booth whisper/);
});
