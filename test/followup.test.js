import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { waitForStationGossipTts, findStationGossipTts } from '../src/ttsWatch.js';
import { appendGeneratedGossip, createFollowupWatcher, formatOnAirTidbit, recoverFullSpokenText } from '../src/followup.js';
import { PERSONA_A, PERSONA_B, PERSONA_C, runGossipAction, stubAdapter, tempStore } from './helpers.js';
test('afterSkillFetch starts a new watch for each call even when another is in flight', async () => {
  const { store } = await tempStore();
  const watchStarts = [];
  const log = {
    info(msg) {
      if (String(msg).includes('watching station-gossip')) watchStarts.push(msg);
    },
    warn() {},
  };
  const watcher = createFollowupWatcher({
    store,
    adapter: stubAdapter(),
    config: { ttsTimeoutMs: 30, ttsPollMs: 1 },
    log,
  });
  const sinceA = new Date('2026-09-19T16:24:20.000Z');
  const sinceB = new Date('2026-09-19T16:24:25.000Z');
  const first = watcher.afterSkillFetch({ show: 'Test Show', since: sinceA });
  const second = watcher.afterSkillFetch({ show: 'Test Show', since: sinceB });
  assert.notEqual(first, second);
  await Promise.all([first, second]);
  assert.equal(watchStarts.length, 2);
});

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
  assert.deepEqual(Object.keys(state), ['tidbits', 'generatedGossipHistory', 'gossipComments']);
  assert.deepEqual(state.generatedGossipHistory, []);
  assert.equal(state.tidbits.length, 1);
  assert.equal(
    state.tidbits[0].text,
    'Uncle Kai said on air, "Shoots, word is da cart machine hiccuped twice last night."',
  );
  assert.equal(state.tidbits[0].hearerPersonaIds, null);
  assert.equal(state.tidbits[0].tellerPersonaId, 'p_79eaff');
  assert.equal(state.tidbits[0].createdAt, '2026-09-19T16:24:49.600Z');
});

test('TTS display name Uncle Kai is stored as his persona id and comments the source rumor', async () => {
  const { store, read } = await tempStore();
  const source = 'Word is Roxy Glo tried to teach Werner Stahl how to clean da bilge pump this mornin, but he keep insistin dat scrub require wearin nothing but a single pair of swim briefs.';
  await store.mutate((state) => {
    state.tidbits.push({
      id: 'rumor-bilge',
      text: source,
      createdAt: '2026-10-15T01:00:00.000Z',
      tellerPersonaId: 'p_other',
      hearerPersonaIds: null,
    });
  });
  const roster = [{ id: 'p_79eaff', name: 'Uncle Kai' }];
  const aired = {
    kind: 'station-gossip',
    text: 'Word is Roxy Glo tried to teach Werner Stahl how to clean da bilge pump this mornin, but he keep insistin dat scrub require wearin nothing but Hawaiian print shorts.',
    t: '2026-10-15T01:34:20.342Z',
    meta: { airedAt: '2026-10-15T01:34:20.342Z', personaId: 'Uncle Kai', personaName: 'Uncle Kai' },
  };
  const session = { session: { show: 'Island Time' } };
  await appendGeneratedGossip({
    store,
    roster,
    showPersonas: roster,
    spoken: aired,
    session,
    log: { info() {}, warn() {} },
  });
  const state = await read();
  const comment = state.gossipComments.find((entry) => entry.tidbitId === 'rumor-bilge');
  assert.equal(comment.actorPersonaId, 'p_79eaff');
  assert.equal(comment.show, 'Island Time');
  assert.equal(state.tidbits.at(-1).tellerPersonaId, 'p_79eaff');
});

test('on-air escalation keeps the matched thread canonical anchors and records its telling', async () => {
  const { store, read } = await tempStore();
  const text = 'Word is Gamma hid the violet microphone in the green room.';
  await store.mutate((state) => {
    state.tidbits.push({
      id: 'source',
      threadId: 'thread-1',
      text,
      createdAt: '2026-10-15T01:00:00.000Z',
      tellerPersonaId: PERSONA_A.id,
      hearerPersonaIds: null,
      canonicalSubjectPersonaId: PERSONA_C.id,
      canonicalTargetPersonaIds: [PERSONA_C.id],
      canonicalAnchors: { location: 'green room', ownerPersonaId: PERSONA_C.id, props: ['violet microphone'] },
    });
  });
  await appendGeneratedGossip({
    store,
    roster: [PERSONA_A, PERSONA_C],
    showPersonas: [PERSONA_A],
    spoken: {
      kind: 'station-gossip',
      text: 'Word is Gamma hid the violet microphone in the green room and blamed the coffee machine.',
      t: '2026-10-15T01:34:20.342Z',
      meta: { personaId: PERSONA_A.id, personaName: PERSONA_A.name },
    },
    log: { info() {}, warn() {} },
  });
  const state = await read();
  const escalated = state.tidbits.at(-1);
  assert.equal(escalated.threadId, 'thread-1');
  assert.deepEqual(escalated.canonicalAnchors, { location: 'green room', ownerPersonaId: PERSONA_C.id, props: ['violet microphone'] });
  assert.deepEqual(escalated.toldAt, ['2026-10-15T01:34:20.342Z']);
});

test('formatOnAirTidbit skips when identity cannot be resolved', () => {
  assert.equal(formatOnAirTidbit({ text: 'hello', meta: {} }, [], []), null);
});

test('recoverFullSpokenText reads matching responses from rolled LLM call log segments', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gossip-llm-log-'));
  const logPath = path.join(dir, 'llm-calls.jsonl');
  const fullText =
    'I have been reflecting further on Werner’s account of the laundry room and the machine that eats all our socks.';
  const shortText = fullText.slice(0, 60);
  const rolledPath = path.join(dir, 'llm-calls.1999999999999.jsonl');
  await writeFile(
    rolledPath,
    `${JSON.stringify({ response: { segment: { kind: 'station-gossip', text: fullText } } })}\n`,
    'utf8',
  );

  const recovered = await recoverFullSpokenText(
    { kind: 'station-gossip', text: shortText, meta: { personaName: 'Reed Silver' } },
    logPath,
    { info() {}, warn() {} },
  );
  assert.equal(recovered.text, fullText);
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

test('formatOnAirTidbit unwraps nested corkboard attribution before persistence', () => {
  const item = formatOnAirTidbit({
    kind: 'station-gossip',
    text: 'Alice said on air, "Alice told Bob, "I saw Carol leave with the transmitter.""',
    meta: { personaId: PERSONA_A.id, personaName: PERSONA_A.name },
  }, [PERSONA_A, PERSONA_B], [PERSONA_A]);
  assert.equal(item.text, 'Alpha said on air, "I saw Carol leave with the transmitter."');
});

test('watcher retries transient fetch failures and reports one classified terminal result', async () => {
  let calls = 0;
  const diagnostics = [];
  const line = { kind: 'station-gossip', text: 'Word is Gamma hid the violet microphone in the green room.', t: '2026-10-20T01:00:00.000Z' };
  const result = await waitForStationGossipTts({
    adapter: {
      async getDebug() {
        calls += 1;
        if (calls === 1) throw new Error('temporary outage');
        return { tts: { recentCalls: [line] } };
      },
    },
    since: new Date('2026-10-20T00:59:00.000Z'),
    timeoutMs: 30,
    settleMs: 1,
    intervalMs: 1,
    sleep: async () => {},
    log: { info(message) { diagnostics.push(message); }, warn(message) { diagnostics.push(message); } },
  });
  assert.equal(result.text, line.text);
  assert.equal(result.watch.outcome, 'matched-speech');
  assert.equal(result.watch.fetchErrors, 1);
  assert.equal(diagnostics.filter((message) => String(message).includes('tts watcher')).length, 1);
});

test('watcher classifies no-air and unmatched speech terminal outcomes', async () => {
  const outcomes = [];
  const watch = async (payload) => waitForStationGossipTts({
    adapter: { async getDebug() { return payload; } },
    since: new Date('2026-10-20T00:59:00.000Z'),
    timeoutMs: 5,
    intervalMs: 1,
    sleep: async () => {},
    onOutcome(result) { outcomes.push(result.outcome); },
    log: { info() {}, warn() {} },
  });
  assert.equal(await watch({ tts: { recentCalls: [] } }), null);
  assert.equal(await watch({ tts: { recentCalls: [{ kind: 'music', text: 'A song', t: '2026-10-20T01:00:00.000Z' }] } }), null);
  assert.deepEqual(outcomes, ['no-segment', 'unmatched-speech']);
});

test('on-air wrapper text correlates with the inner quoted rumor thread', async () => {
  const { store, read } = await tempStore();
  const rumor = 'Word is Gamma hid the violet microphone in the green room after midnight.';
  await store.mutate((state) => {
    state.tidbits.push({ id: 'wrapped-source', threadId: 'wrapped-thread', text: `Alpha told Beta, "${rumor}"`, createdAt: '2026-10-20T00:00:00.000Z', tellerPersonaId: PERSONA_A.id, hearerPersonaIds: [PERSONA_B.id] });
  });
  await appendGeneratedGossip({
    store,
    roster: [PERSONA_A, PERSONA_B],
    showPersonas: [PERSONA_A],
    spoken: { kind: 'station-gossip', text: `Alpha said on air, "${rumor}"`, meta: { personaId: PERSONA_A.id, personaName: PERSONA_A.name } },
    log: { info() {}, warn() {} },
  });
  assert.equal((await read()).tidbits.at(-1).threadId, 'wrapped-thread');
});

test('cohosted explicit speaker wins when session metadata is sparse', () => {
  const item = formatOnAirTidbit({
    kind: 'station-gossip-cohosted',
    text: 'Word is Gamma hid the violet microphone in the green room.',
    meta: { personaId: PERSONA_B.id, personaName: PERSONA_B.name },
  }, [PERSONA_A, PERSONA_B], [PERSONA_A], { messages: [] });
  assert.equal(item.tellerPersonaId, PERSONA_B.id);
});

test('two follow-up processes keep both on-air tidbits, comments, and tellings', async () => {
  const { filePath, read } = await tempStore();
  const barrier = await mkdtemp(path.join(tmpdir(), 'gossip-barrier-'));
  const firstText = 'Shoots, word is da cart machine hiccuped twice last night.';
  const secondText = 'Shoots, word is da neon sign blinked a secret code at midnight.';
  const [first, second] = await Promise.all([
    runGossipAction('follow-up', {
      STATE_PATH: filePath,
      SPOKEN_TEXT: firstText,
      AIRED_AT: '2026-09-19T16:24:49.600Z',
      BARRIER_DIR: barrier,
      BARRIER_NAME: 'a',
      BARRIER_PEERS: 'a,b',
    }),
    runGossipAction('follow-up', {
      STATE_PATH: filePath,
      SPOKEN_TEXT: secondText,
      AIRED_AT: '2026-09-19T16:30:00.000Z',
      BARRIER_DIR: barrier,
      BARRIER_NAME: 'b',
      BARRIER_PEERS: 'a,b',
    }),
  ]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const disk = await read();
  assert.equal(disk.tidbits.length, 2);
  assert.equal(disk.tidbits.every((item) => item.toldAt.length === 1), true);
  assert.equal(disk.gossipComments.length, 2);
  assert.equal(disk.tidbits.some((item) => item.text.includes(firstText)), true);
  assert.equal(disk.tidbits.some((item) => item.text.includes(secondText)), true);
});
