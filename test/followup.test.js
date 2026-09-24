import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitForStationGossipTts, findStationGossipTts } from '../src/ttsWatch.js';
import { appendGeneratedGossip, formatOnAirTidbit } from '../src/followup.js';
import { PERSONA_A, PERSONA_B, PERSONA_C, stubAdapter, tempStore } from './helpers.js';
test('cohosted TTS expands all speakers from the matching station LLM call', async () => {
  const first = {
    kind: 'station-gossip-cohosted',
    text: 'First cohost line',
    t: '2026-09-24T02:00:00.000Z',
    meta: { airedAt: '2026-09-24T02:00:00.000Z' },
  };
  const adapter = {
    async getDebug() {
      return {
        tts: { recentCalls: [first] },
        llm: {
          recentCalls: [{
            response: {
              lines: [
                { speaker: 'p_a', text: 'First cohost line' },
                { speaker: 'p_b', text: 'Second cohost line' },
              ],
            },
          }],
        },
      };
    },
  };
  const lines = await waitForStationGossipTts({
    adapter,
    since: new Date('2026-09-24T01:59:00.000Z'),
    timeoutMs: 50,
    settleMs: 1,
    intervalMs: 1,
    sleep: async () => {},
    log: { info() {}, warn() {} },
  });
  assert.deepEqual(lines.map((line) => [line.meta.personaId, line.text]), [
    ['p_a', 'First cohost line'],
    ['p_b', 'Second cohost line'],
  ]);
});
test('solo TTS expands the matching station LLM segment', async () => {
  const fullText = 'I have been reflecting further on Werner’s account of the laundry room and the machine that eats all our socks.';
  const lines = await waitForStationGossipTts({
    adapter: {
      async getDebug() {
        return {
          tts: {
            recentCalls: [{
              kind: 'station-gossip',
              persona: 'Reed Silver',
              text: fullText.slice(0, 60),
              t: '2026-09-24T02:10:00.000Z',
            }],
          },
          llm: {
            recentCalls: [{
              response: {
                segment: { kind: 'station-gossip', text: fullText, sfx: null },
              },
            }],
          },
        };
      },
    },
    since: new Date('2026-09-24T02:09:00.000Z'),
    timeoutMs: 50,
    settleMs: 1,
    intervalMs: 1,
    sleep: async () => {},
    log: { info() {}, warn() {} },
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, fullText);
  assert.equal(lines[0].meta.personaName, 'Reed Silver');
});
test('solo TTS expands a station LLM response text', async () => {
  const fullText = 'A complete solo line that is longer than the truncated TTS record.';
  const result = await waitForStationGossipTts({
    adapter: {
      async getDebug() {
        return {
          tts: { recentCalls: [{ kind: 'station-gossip', persona: 'Reed Silver', text: fullText.slice(0, 30), t: '2026-09-24T02:20:00.000Z' }] },
          llm: { recentCalls: [{ response: JSON.stringify({ air: true, text: fullText }) }] },
        };
      },
    },
    since: new Date('2026-09-24T02:19:00.000Z'),
    timeoutMs: 20,
    settleMs: 1,
    intervalMs: 1,
    sleep: async () => {},
    log: { info() {}, warn() {} },
  });
  assert.equal(result[0].text, fullText);
});




const spoken = {
  kind: 'station-gossip',
  text: 'Shoots, word is da cart machine hiccuped twice last night.',
  t: '2026-09-19T16:24:49.607Z',
  meta: {
    airedAt: '2026-09-19T16:24:49.600Z',
    personaId: 'p_79eaff',
    personaName: 'Uncle Kai',
  },
};

test('waitForStationGossipTts returns the post-skill TTS line and times out otherwise', async () => {
  const since = new Date('2026-09-19T16:24:20.000Z');
  const found = findStationGossipTts({ messages: [spoken] }, since);
  assert.equal(found.length, 1);
  assert.equal(findStationGossipTts({ messages: [spoken] }, new Date('2026-09-19T16:25:00.000Z')).length, 0);

  let calls = 0;
  const adapter = {
    async getDebug() {
      calls += 1;
      if (calls < 2) return { tts: { recentCalls: [] } };
      return {
        tts: {
          recentCalls: [{
            kind: 'station-gossip',
            text: spoken.text,
            persona: 'Uncle Kai',
            at: spoken.meta.airedAt,
          }],
        },
      };
    },
    async getSession() {
      return { messages: [] };
    },
  };
  const hit = await waitForStationGossipTts({
    adapter,
    since,
    timeoutMs: 200,
    intervalMs: 1,
    settleMs: 1,
    sleep: async () => {},
    log: { info() {}, warn() {} },
  });
  assert.equal(hit.text, spoken.text);

  const miss = await waitForStationGossipTts({
    adapter: stubAdapter(),
    since,
    timeoutMs: 5,
    intervalMs: 1,
    sleep: async () => {},
    log: { info() {}, warn() {} },
  });
  assert.equal(miss, null);
});

test('appendGeneratedGossip stores on-air text with null hearers and is idempotent', async () => {
  const { store, read } = await tempStore();
  const roster = [{ id: 'p_79eaff', name: 'Uncle Kai' }, PERSONA_A, PERSONA_B, PERSONA_C];
  const first = await appendGeneratedGossip({
    store,
    roster,
    showPersonas: [PERSONA_A],
    spoken,
    log: { info() {}, warn() {} },
  });
  assert.equal(first.added, 1);
  const second = await appendGeneratedGossip({
    store,
    roster,
    showPersonas: [PERSONA_A],
    spoken,
    log: { info() {}, warn() {} },
  });
  assert.equal(second.skipped, true);
  const state = await read();
  assert.deepEqual(Object.keys(state), ['tidbits']);
  assert.equal(state.tidbits.length, 1);
  assert.equal(
    state.tidbits[0].text,
    'Uncle Kai said on air, "Shoots, word is da cart machine hiccuped twice last night."',
  );
  assert.equal(state.tidbits[0].hearerPersonaIds, null);
  assert.equal(state.tidbits[0].tellerPersonaId, 'p_79eaff');
  assert.equal(state.tidbits[0].createdAt, '2026-09-19T16:24:49.600Z');
});

test('formatOnAirTidbit skips when identity cannot be resolved', () => {
  assert.equal(formatOnAirTidbit({ text: 'hello', meta: {} }, [], []), null);
});

test('formatOnAirTidbit uses last session speaker when TTS meta has no persona', () => {
  const spokenBare = {
    kind: 'station-gossip',
    text: 'Word is someone left a little surprise in the urinal. Totally bogus, man.',
    t: '2026-09-19T17:01:30.649Z',
    meta: { airedAt: '2026-09-19T17:01:30.340Z' },
  };
  const session = {
    session: { show: 'The Last Request' },
    messages: [
      {
        t: '2026-09-19T17:00:32.760Z',
        meta: { personaId: 'p_79eaff', personaName: 'Uncle Kai', airedAt: '2026-09-19T17:00:32.760Z' },
      },
      {
        t: '2026-09-19T17:00:38.570Z',
        meta: { personaId: 'p_66b834', personaName: 'Reed Silver', airedAt: '2026-09-19T17:00:38.570Z' },
      },
      spokenBare,
    ],
  };
  const roster = [
    { id: 'p_79eaff', name: 'Uncle Kai' },
    { id: 'p_66b834', name: 'Reed Silver' },
  ];
  const item = formatOnAirTidbit(spokenBare, roster, [{ id: 'p_79eaff', name: 'Uncle Kai' }], session);
  assert.equal(item.tellerPersonaId, 'p_66b834');
  assert.equal(
    item.text,
    'Reed Silver said on air, "Word is someone left a little surprise in the urinal. Totally bogus, man."',
  );
});
