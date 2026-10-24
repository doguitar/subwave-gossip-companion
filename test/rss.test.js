import assert from 'node:assert/strict';
import { readFile, utimes, writeFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { createServer } from '../src/server.js';
import { PERSONA_A, PERSONA_B, stubAdapter, tempStore, tidbit } from './helpers.js';

const servers = [];

async function start(store, adapter, feedBaseUrl = '') {
  const config = { host: '127.0.0.1', port: 0, feedBaseUrl };
  const server = createServer({ store, adapter, config, log: { warn() {}, error() {}, info() {} }, watcher: { afterSkillFetch() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

after(() => {
  for (const s of servers) s.close();
});

test('repeated RSS polls skip an unchanged state file and still see external and local edits', async () => {
  const { store, filePath, read } = await tempStore({
    tidbits: [tidbit({ text: 'A only', tellerPersonaId: PERSONA_A.id, hearerPersonaIds: null })],
  });
  const base = await start(store, stubAdapter());
  const before = store.stateReads;
  const first = await fetch(`${base}/gossip.rss?show=${encodeURIComponent('Test Show')}`);
  const second = await fetch(`${base}/gossip.rss?show=${encodeURIComponent('Test Show')}`);
  const health = await fetch(`${base}/health`);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(health.status, 200);
  assert.equal(store.stateReads, before);
  assert.match(await first.text(), /A only/);

  const disk = await read();
  disk.tidbits[0].text = 'Alpha told Beta, "external cart rumor"';
  await writeFile(filePath, `${JSON.stringify(disk)}\n`);
  const bumped = new Date(Date.now() + 5000);
  await utimes(filePath, bumped, bumped);
  const external = await (await fetch(`${base}/gossip.rss?show=${encodeURIComponent('Test Show')}`)).text();
  assert.match(external, /external cart rumor/);
  assert.equal(store.stateReads, before + 1);

  await store.mutate((state) => {
    state.tidbits[0].text = 'Alpha told Beta, "local cart rumor"';
  });
  const afterMutate = store.stateReads;
  const local = await (await fetch(`${base}/gossip.rss?show=${encodeURIComponent('Test Show')}`)).text();
  assert.match(local, /local cart rumor/);
  assert.equal(store.stateReads, afterMutate);
});

test('RSS includes known and broadcast-null items, excludes unknown, and emits display-name relationships', async () => {
  const { store } = await tempStore({
    tidbits: [
      tidbit({ text: 'A only', tellerPersonaId: PERSONA_A.id, createdAt: '2026-09-19T02:00:00.000Z' }),
      tidbit({ text: 'B only', tellerPersonaId: PERSONA_B.id, hearerPersonaIds: [PERSONA_B.id], createdAt: '2026-09-19T01:00:00.000Z' }),
      tidbit({ text: 'Nobody knows', tellerPersonaId: 'p_z', hearerPersonaIds: ['p_z'] }),
      tidbit({
        text: 'Broadcast item',
        tellerPersonaId: PERSONA_A.id,
        hearerPersonaIds: null,
        createdAt: '2026-09-18T00:00:00.000Z',
      }),
    ],
  });
  const base = await start(store, stubAdapter());
  const res = await fetch(`${base}/gossip.rss?show=${encodeURIComponent('Test Show')}`);
  assert.equal(res.status, 200);
  const xml = await res.text();
  assert.match(xml, /<rss version="2.0">/);
  assert.match(xml, /A only/);
  assert.match(xml, /B only/);
  assert.match(xml, /Broadcast item/);
  assert.doesNotMatch(xml, /Nobody knows/);
  assert.match(xml, /<channel>[\s\S]*<title>Station Gossip<\/title>/);
  assert.match(xml, /<link>http:\/\/127\.0\.0\.1:\d+\/gossip\.rss\?show=Test%20Show<\/link>/);
  assert.doesNotMatch(xml, /tellerPersonaId|hearerPersonaIds/);
  assert.doesNotMatch(xml, />p_a<|>p_b</);
  assert.match(xml, /<gossipHearers>Beta<\/gossipHearers>/);
  const titles = [...xml.matchAll(/<item>[\s\S]*?<title>([^<]+)<\/title>/g)].map((m) => m[1]);
  assert.deepEqual(titles, ['Broadcast item', 'B only', 'A only']);
});

test('root page lists active tidbits in board order and escapes HTML', async () => {
  const { store } = await tempStore({
    tidbits: [
      tidbit({ text: '<first>' }),
      tidbit({ text: 'second & more' }),
    ],
  });
  const base = await start(store, stubAdapter());
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<ol><li>&lt;first&gt;<\/li><li>second &amp; more<\/li><\/ol>/);
});

const STORED_BOARD = '<ol><li>Alpha told Beta, &quot;The spare mic is in the green room.&quot;</li><li>Gamma kept this one</li><li>Booth rumor from the host</li></ol>';
const ON_AIR_RUMORS = '<h2>Show rumors</h2><p>On Air</p><p>Alpha, Beta</p><ol><li>Booth rumor from the host<i>Alpha</i></li><li>The spare mic is in the green room.<i>Alpha</i><i>Beta</i></li></ol>';

function showBoard() {
  return {
    tidbits: [
      tidbit({
        text: 'Alpha told Beta, "The spare mic is in the green room."',
        tellerPersonaId: PERSONA_A.id,
        hearerPersonaIds: [PERSONA_B.id],
        createdAt: '2026-09-19T03:00:00.000Z',
      }),
      tidbit({
        text: 'Gamma kept this one',
        tellerPersonaId: 'p_c',
        hearerPersonaIds: ['p_c'],
        createdAt: '2026-09-19T01:00:00.000Z',
      }),
      tidbit({
        text: 'Booth rumor from the host',
        tellerPersonaId: PERSONA_A.id,
        hearerPersonaIds: [],
        createdAt: '2026-09-19T02:00:00.000Z',
      }),
    ],
  };
}

test('show rumors names the on-air show, falls back to the session, and keeps the board when the station read fails', async () => {
  const { store } = await tempStore(showBoard());
  const onAir = await start(store, stubAdapter({
    show: 'On Air',
    nowPlaying: { activeShow: { name: 'On Air' } },
    session: { session: { show: 'Incoming Hour' } },
  }));
  const onAirRes = await fetch(`${onAir}/`);
  assert.equal(onAirRes.status, 200);
  const onAirHtml = await onAirRes.text();
  assert.ok(onAirHtml.indexOf('<h1>Station Gossip</h1>') < onAirHtml.indexOf(STORED_BOARD));
  assert.ok(onAirHtml.indexOf(STORED_BOARD) < onAirHtml.indexOf('<h2>Show rumors</h2>'));
  assert.ok(onAirHtml.includes(ON_AIR_RUMORS));
  assert.doesNotMatch(onAirHtml.split('<h2>Show rumors</h2>')[1], /Incoming Hour|Gamma kept|p_a|p_b|p_c/);

  const { store: sessionStore } = await tempStore(showBoard());
  const sessionBase = await start(sessionStore, stubAdapter({
    show: 'On Air',
    nowPlaying: { activeShow: null },
    session: { session: { show: 'On Air' } },
  }));
  const sessionRes = await fetch(`${sessionBase}/`);
  assert.equal(sessionRes.status, 200);
  const sessionHtml = await sessionRes.text();
  assert.ok(sessionHtml.includes(STORED_BOARD));
  assert.ok(sessionHtml.indexOf(STORED_BOARD) < sessionHtml.indexOf('<h2>Show rumors</h2>'));
  assert.ok(sessionHtml.includes(ON_AIR_RUMORS));

  const { store: failedStore } = await tempStore(showBoard());
  const failedBase = await start(failedStore, stubAdapter({
    show: 'On Air',
    failNowPlaying: true,
    session: { session: { show: 'On Air' } },
  }));
  const failedRes = await fetch(`${failedBase}/`);
  assert.equal(failedRes.status, 200);
  const failedHtml = await failedRes.text();
  assert.ok(failedHtml.includes(STORED_BOARD));
  assert.ok(failedHtml.indexOf(STORED_BOARD) < failedHtml.indexOf('<h2>Show rumors</h2>'));
  const failedSection = failedHtml.split('<h2>Show rumors</h2>')[1];
  assert.match(failedSection, /The current show could not be loaded\./);
  assert.doesNotMatch(failedSection, /On Air|Booth rumor|spare mic|Alpha|Beta/);
});

test('show rumors says when nothing is on air', async () => {
  const { store } = await tempStore({
    tidbits: [tidbit({ text: 'Board only rumor' })],
  });
  const base = await start(store, stubAdapter({
    nowPlaying: { activeShow: { name: '   ' } },
    session: { session: { show: '' } },
  }));
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<h1>Station Gossip<\/h1><ol><li>Board only rumor<\/li><\/ol>/);
  assert.equal(html.split('<h2>Show rumors</h2>')[1], '<p>No current show is on air.</p></body></html>');
});

test('show rumors keeps a nameless DJ line and shows an unmatched title alone', async () => {
  const { store } = await tempStore({
    tidbits: [tidbit({
      text: 'Only the booth knows',
      tellerPersonaId: PERSONA_A.id,
      hearerPersonaIds: [PERSONA_B.id],
      createdAt: '2026-09-19T02:00:00.000Z',
    })],
  });
  const namelessBase = await start(store, stubAdapter({
    show: 'Quiet Hour',
    schedulePersonas: [
      { id: PERSONA_A.id, name: PERSONA_A.id },
      { id: PERSONA_B.id, name: PERSONA_B.id },
    ],
    nowPlaying: { activeShow: { name: 'Quiet Hour' } },
  }));
  const namelessHtml = await (await fetch(`${namelessBase}/`)).text();
  assert.equal(namelessHtml.split('<h2>Show rumors</h2>')[1], '<p>Quiet Hour</p><p></p><ol><li>Only the booth knows</li></ol></body></html>');
  assert.doesNotMatch(namelessHtml, /p_a|p_b|p_c/);

  const { store: unknownStore } = await tempStore({
    tidbits: [tidbit({ text: 'Only the booth knows', tellerPersonaId: PERSONA_A.id })],
  });
  const unknownBase = await start(unknownStore, stubAdapter({
    show: 'On Air',
    nowPlaying: { activeShow: { name: 'No Such Show' } },
  }));
  const unknownHtml = await (await fetch(`${unknownBase}/`)).text();
  assert.equal(unknownHtml.split('<h2>Show rumors</h2>')[1], '<p>No Such Show</p><ol></ol></body></html>');
  assert.match(unknownHtml, /<li>Only the booth knows<\/li>/);
});

test('show rumors escapes the show line and reports schedule or session load failure', async () => {
  const { store } = await tempStore({
    tidbits: [tidbit({
      text: 'Alpha told Beta, "1 < 2 & 3"',
      tellerPersonaId: PERSONA_A.id,
      hearerPersonaIds: [PERSONA_B.id],
      createdAt: '2026-09-19T02:00:00.000Z',
    })],
  });
  const escapedBase = await start(store, stubAdapter({
    show: 'Rock & Roll',
    schedulePersonas: [
      { id: PERSONA_A.id, name: 'A<B>' },
      { id: PERSONA_B.id, name: 'Be"ta' },
    ],
    nowPlaying: { activeShow: { name: 'Rock & Roll' } },
    session: { session: { show: 'p_a incoming' } },
  }));
  const escapedRes = await fetch(`${escapedBase}/`);
  assert.equal(escapedRes.status, 200);
  const escapedHtml = await escapedRes.text();
  assert.equal(
    escapedHtml.split('<h2>Show rumors</h2>')[1],
    '<p>Rock &amp; Roll</p><p>A&lt;B&gt;, Be&quot;ta</p><ol><li>1 &lt; 2 &amp; 3<i>A&lt;B&gt;</i><i>Be&quot;ta</i></li></ol></body></html>',
  );
  assert.doesNotMatch(escapedHtml, /p_a|p_b|p_c/);

  const { store: scheduleStore } = await tempStore({
    tidbits: [tidbit({ text: 'Board only rumor' })],
  });
  const scheduleBase = await start(scheduleStore, stubAdapter({
    show: 'On Air',
    failSchedule: true,
    nowPlaying: { activeShow: { name: 'On Air' } },
  }));
  const scheduleRes = await fetch(`${scheduleBase}/`);
  assert.equal(scheduleRes.status, 200);
  const scheduleHtml = await scheduleRes.text();
  assert.match(scheduleHtml, /<li>Board only rumor<\/li>/);
  assert.equal(scheduleHtml.split('<h2>Show rumors</h2>')[1], '<p>The current show could not be loaded.</p></body></html>');

  const { store: sessionStore } = await tempStore({
    tidbits: [tidbit({ text: 'Board only rumor' })],
  });
  const sessionBase = await start(sessionStore, stubAdapter({
    failSession: true,
    nowPlaying: { activeShow: null },
    session: { session: { show: 'On Air' } },
  }));
  const sessionHtml = await (await fetch(`${sessionBase}/`)).text();
  assert.match(sessionHtml, /<li>Board only rumor<\/li>/);
  assert.equal(sessionHtml.split('<h2>Show rumors</h2>')[1], '<p>The current show could not be loaded.</p></body></html>');

  const { store: keptStore } = await tempStore({
    tidbits: [tidbit({
      text: 'Booth rumor from the host',
      tellerPersonaId: PERSONA_A.id,
      hearerPersonaIds: [],
      createdAt: '2026-09-19T02:00:00.000Z',
    })],
  });
  const keptBase = await start(keptStore, stubAdapter({
    show: 'On Air',
    failSession: true,
    nowPlaying: { activeShow: { name: 'On Air' } },
  }));
  const keptHtml = await (await fetch(`${keptBase}/`)).text();
  assert.match(keptHtml, /<h2>Show rumors<\/h2><p>On Air<\/p><p>Alpha, Beta<\/p><ol><li>Booth rumor from the host<i>Alpha<\/i><\/li><\/ol>/);
  assert.doesNotMatch(keptHtml, /could not be loaded/);
});

test('schedule unavailable returns JSON error instead of empty RSS', async () => {
  const { store } = await tempStore({
    tidbits: [tidbit({ text: 'Should not leak' })],
  });
  const base = await start(store, stubAdapter({ failSchedule: true }));
  const res = await fetch(`${base}/gossip.rss?show=${encodeURIComponent('Test Show')}`);
  assert.ok(res.status >= 400);
  const body = await res.text();
  assert.doesNotMatch(body, /<rss/i);
  const json = JSON.parse(body);
  assert.match(json.error, /schedule down/i);
});

test('corrupt state reload returns JSON error instead of an empty RSS feed', async () => {
  const { store, filePath } = await tempStore({
    tidbits: [tidbit({ text: 'Should not leak', hearerPersonaIds: null })],
  });
  const corrupt = '{"tidbits":';
  await writeFile(filePath, corrupt);
  const followCalls = [];
  const config = { host: '127.0.0.1', port: 0, feedBaseUrl: '' };
  const server = createServer({
    store,
    adapter: stubAdapter(),
    config,
    log: { warn() {}, error() {}, info() {} },
    watcher: {
      afterSkillFetch(args) {
        followCalls.push(args);
      },
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/gossip.rss?show=${encodeURIComponent('Test Show')}`);
  assert.ok(res.status >= 400);
  const body = await res.text();
  assert.doesNotMatch(body, /<rss/i);
  assert.equal(JSON.parse(body).error, `${filePath} is not valid JSON`);
  assert.equal(await readFile(filePath, 'utf8'), corrupt);
  assert.equal(followCalls.length, 0);
});

test('missing show is 400; unknown and empty-persona shows are empty 200', async () => {
  const { store } = await tempStore({
    tidbits: [tidbit({ text: 'Secret global item' })],
  });
  const base = await start(store, stubAdapter());

  const missing = await fetch(`${base}/gossip.rss`);
  assert.equal(missing.status, 400);
  assert.match(await missing.text(), /show query parameter is required/);

  const unknown = await fetch(`${base}/gossip.rss?show=${encodeURIComponent('No Such Show')}`);
  assert.equal(unknown.status, 200);
  const unknownXml = await unknown.text();
  assert.match(unknownXml, /<rss version="2.0">/);
  assert.doesNotMatch(unknownXml, /Secret global item/);
  assert.doesNotMatch(unknownXml, /<item>/);

  const empty = await fetch(`${base}/gossip.rss?show=${encodeURIComponent('Empty Show')}`);
  assert.equal(empty.status, 200);
  assert.doesNotMatch(await empty.text(), /<item>/);
});

test('RSS picks up an external state edit when the file mtime changes', async () => {
  const { store, filePath } = await tempStore({
    tidbits: [tidbit({ text: 'Before edit', hearerPersonaIds: null })],
  });
  const base = await start(store, stubAdapter());
  const first = await (await fetch(`${base}/gossip.rss?show=${encodeURIComponent('Test Show')}`)).text();
  assert.match(first, /Before edit/);

  await writeFile(filePath, `${JSON.stringify({
    tidbits: [tidbit({ text: 'After edit unique', hearerPersonaIds: null, createdAt: '2026-09-19T12:00:00.000Z' })],
  }, null, 2)}\n`);
  const second = await (await fetch(`${base}/gossip.rss?show=${encodeURIComponent('Test Show')}`)).text();
  assert.match(second, /After edit unique/);
  assert.doesNotMatch(second, /Before edit/);

  await writeFile(filePath, `${JSON.stringify({ tidbits: [] }, null, 2)}\n`);
  const third = await (await fetch(`${base}/gossip.rss?show=${encodeURIComponent('Test Show')}`)).text();
  assert.doesNotMatch(third, /<item>/);
});

test('RSS without actor starts TTS follow-up when the feed has items', async () => {
  const followCalls = [];
  const watcher = {
    afterSkillFetch(args) {
      followCalls.push(args);
    },
  };
  const { store } = await tempStore({
    tidbits: [tidbit({ text: 'Feed item', hearerPersonaIds: null })],
  });
  const config = { host: '127.0.0.1', port: 0, feedBaseUrl: '' };
  const server = createServer({
    store,
    adapter: stubAdapter(),
    config,
    log: { warn() {}, error() {}, info() {} },
    watcher,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const res = await fetch(`${base}/gossip.rss?show=${encodeURIComponent('Test Show')}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Feed item/);
  assert.equal(followCalls.length, 1);
  assert.equal(followCalls[0].show, 'Test Show');
  assert.ok(followCalls[0].since instanceof Date);
});

test('RSS with actor starts TTS follow-up when the feed has items', async () => {
  const followCalls = [];
  const watcher = {
    afterSkillFetch(args) {
      followCalls.push(args);
    },
  };
  const { store } = await tempStore({
    tidbits: [tidbit({ text: 'Skill item', hearerPersonaIds: null })],
  });
  const config = { host: '127.0.0.1', port: 0, feedBaseUrl: '' };
  const server = createServer({
    store,
    adapter: stubAdapter(),
    config,
    log: { warn() {}, error() {}, info() {} },
    watcher,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const res = await fetch(`${base}/gossip.rss?show=${encodeURIComponent('Test Show')}&actor=${encodeURIComponent(PERSONA_A.id)}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Skill item/);
  assert.equal(followCalls.length, 1);
  assert.equal(followCalls[0].show, 'Test Show');
  assert.ok(followCalls[0].since instanceof Date);
});

test('each item-bearing RSS request starts TTS follow-up regardless of actor', async () => {
  const followCalls = [];
  const watcher = {
    afterSkillFetch(args) {
      followCalls.push(args);
    },
  };
  const { store } = await tempStore({
    tidbits: [tidbit({ text: 'Shared item', hearerPersonaIds: null })],
  });
  const config = { host: '127.0.0.1', port: 0, feedBaseUrl: '' };
  const server = createServer({
    store,
    adapter: stubAdapter(),
    config,
    log: { warn() {}, error() {}, info() {} },
    watcher,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  await fetch(`${base}/gossip.rss?show=${encodeURIComponent('Test Show')}`);
  await fetch(`${base}/gossip.rss?show=${encodeURIComponent('Test Show')}&actor=${encodeURIComponent(PERSONA_A.id)}`);
  assert.equal(followCalls.length, 2);
  assert.equal(followCalls[0].show, 'Test Show');
  assert.equal(followCalls[1].show, 'Test Show');
});

test('empty RSS feed does not start TTS follow-up', async () => {
  let followCalls = 0;
  const watcher = {
    afterSkillFetch() {
      followCalls += 1;
    },
  };
  const { store } = await tempStore({
    tidbits: [tidbit({ text: 'Secret global item' })],
  });
  const config = { host: '127.0.0.1', port: 0, feedBaseUrl: '' };
  const server = createServer({
    store,
    adapter: stubAdapter(),
    config,
    log: { warn() {}, error() {}, info() {} },
    watcher,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const res = await fetch(`${base}/gossip.rss?show=${encodeURIComponent('Empty Show')}`);
  assert.equal(res.status, 200);
  assert.doesNotMatch(await res.text(), /<item>/);
  assert.equal(followCalls, 0);
});

test('actor RSS separates told-shape rumor from escaped teller and hearer metadata', async () => {
  const { store } = await tempStore({
    tidbits: [
      tidbit({
        id: 'rumor-1',
        text: 'Alpha told Beta, "Alpha & Beta <heard> "news""',
        tellerPersonaId: PERSONA_A.id,
        hearerPersonaIds: [PERSONA_B.id],
        createdAt: '2026-09-19T02:00:00.000Z',
      }),
    ],
  });
  const base = await start(store, stubAdapter());
  const res = await fetch(`${base}/gossip.rss?show=${encodeURIComponent('Test Show')}&actor=persona-a`);
  assert.equal(res.status, 200);
  const xml = await res.text();
  assert.match(xml, /<description>Alpha &amp; Beta &lt;heard&gt; &quot;news&quot;<\/description>/);
  assert.doesNotMatch(xml, /Alpha told Beta/);
  assert.match(xml, /<guid isPermaLink="false">rumor-1<\/guid>/);
  assert.match(xml, /<pubDate>[^<]+<\/pubDate>/);
  assert.match(xml, /<gossipTeller>Alpha<\/gossipTeller>/);
  assert.match(xml, /<gossipHearers>Beta<\/gossipHearers>/);
  assert.doesNotMatch(xml, /p_a|p_b|PERSONA/);
});

test('feedBaseUrl self-link includes show and actor query params', async () => {
  const { store } = await tempStore({
    tidbits: [tidbit({ text: 'Rumor', tellerPersonaId: PERSONA_A.id, hearerPersonaIds: null })],
  });
  const base = await start(store, stubAdapter(), 'http://companion.test');
  const res = await fetch(
    `${base}/gossip.rss?show=${encodeURIComponent('Test Show')}&actor=${encodeURIComponent('persona-a')}`,
  );
  assert.equal(res.status, 200);
  const xml = await res.text();
  assert.match(
    xml,
    /<link>http:\/\/companion\.test\/gossip\.rss\?show=Test%20Show&amp;actor=persona-a<\/link>/,
  );
  const linkCount = [...xml.matchAll(/<link>[^<]+<\/link>/g)].length;
  assert.equal(linkCount, 2);
});

test('feedBaseUrl self-link omits actor when request has no actor', async () => {
  const { store } = await tempStore({
    tidbits: [tidbit({ text: 'Rumor', tellerPersonaId: PERSONA_A.id, hearerPersonaIds: null })],
  });
  const base = await start(store, stubAdapter(), 'http://companion.test');
  const res = await fetch(`${base}/gossip.rss?show=${encodeURIComponent('Test Show')}`);
  assert.equal(res.status, 200);
  const xml = await res.text();
  assert.match(xml, /<link>http:\/\/companion\.test\/gossip\.rss\?show=Test%20Show<\/link>/);
  assert.doesNotMatch(xml, /actor=/);
});

test('a non-empty RSS response during shutdown is still served and does not start a watch', async () => {
  const { store } = await tempStore({
    tidbits: [tidbit({
      text: 'Broadcast item',
      tellerPersonaId: PERSONA_A.id,
      hearerPersonaIds: null,
      createdAt: new Date().toISOString(),
    })],
  });
  const followCalls = [];
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  let started = false;
  const server = createServer({
    store,
    adapter: stubAdapter(),
    config: {
      host: '127.0.0.1',
      port: 0,
      feedBaseUrl: '',
      refreshSecret: 'test-secret',
      refreshMinIntervalMs: 0,
      refreshMaxConcurrency: 1,
      refreshCount: 1,
      gossipHistoryGenerations: 7,
      threadMaxTellings: 3,
      threadMaxAgeMs: 24 * 60 * 60 * 1000,
    },
    log: { warn() {}, error() {}, info() {} },
    generate: ({ signal }) => {
      started = true;
      return gate.then(() => {
      if (signal?.aborted) throw Object.assign(new Error('shutting down'), { name: 'AbortError', reason: 'shutdown' });
      return { rumor: 'word is the booth kettle whistled through the legal ID' };
    });
    },
    pickRoles: () => ({ teller: PERSONA_A, hearers: [], targets: [] }),
    summarizeSouls: async (roster) => roster,
    summarizeHouseRules: async (rules) => rules,
    watcher: {
      afterSkillFetch(args) {
        followCalls.push(args);
      },
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const before = await fetch(`${base}/gossip.rss?show=${encodeURIComponent('Test Show')}`);
  assert.equal(before.status, 200);
  assert.match(await before.text(), /Broadcast item/);
  assert.equal(followCalls.length, 1);
  const headers = { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' };
  const admitted = fetch(`${base}/refresh`, { method: 'POST', headers, body: '{}' });
  while (!started) await new Promise((resolve) => setTimeout(resolve, 10));
  const draining = server.shutdown({ signal: 'SIGTERM', deadlineMs: 1000 });
  const during = await fetch(`${base}/gossip.rss?show=${encodeURIComponent('Test Show')}`);
  assert.equal(during.status, 200);
  assert.match(await during.text(), /Broadcast item/);
  assert.equal(followCalls.length, 1);
  release();
  await admitted.catch(() => {});
  await draining;
});
