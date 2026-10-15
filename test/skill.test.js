import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import runGossipSkill from '../skills/station-gossip/tool.mjs';

test('skill is silent on empty or unavailable feeds', async () => {
  const empty = await runGossipSkill(
    { show: 'Test Show' },
    {},
    { fetch: async () => ({ ok: true, text: async () => '<rss version="2.0"><channel></channel></rss>' }) },
    { feedUrl: 'http://companion.test' },
  );
  assert.deepEqual(empty, { available: false });

  const down = await runGossipSkill(
    { show: 'Test Show' },
    {},
    { fetch: async () => { throw new Error('econnrefused'); } },
    { feedUrl: 'http://companion.test' },
  );
  assert.deepEqual(down, { available: false });
});

test('skill returns items without teller or spoken-id events', async () => {
  const xml = `<?xml version="1.0"?>
<rss version="2.0"><channel>
<item><guid>abc</guid><description>Word is the cart skipped</description></item>
<item><guid>def</guid><description>Someone swears the neon sign blinked twice</description></item>
</channel></rss>`;
  const result = await runGossipSkill(
    { show: 'Test Show', spoken: 'Word is the cart skipped' },
    {},
    { fetch: async (url) => {
      assert.equal(url, 'http://companion.test/gossip.rss?show=Test%20Show');
      return { ok: true, text: async () => xml };
    } },
    { feedUrl: 'http://companion.test' },
  );
  assert.equal(result.available, true);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].text, 'Word is the cart skipped');
  assert.equal(result.events, undefined);
  assert.ok(!JSON.stringify(result).includes('tidbit_id'));
  assert.ok(!JSON.stringify(result.items).includes('teller'));
});

test('skill appends the encoded actor and keeps teller metadata', async () => {
  const xml = `<?xml version="1.0"?>
<rss version="2.0"><channel>
<item>
  <guid>rumor-1</guid>
  <description>Alpha &amp; Beta heard the cart skip twice</description>
  <pubDate>Sat, 19 Sep 2026 02:00:00 GMT</pubDate>
  <gossipTeller>Alpha &amp; Crew</gossipTeller>
</item>
</channel></rss>`;
  const result = await runGossipSkill(
    { show: 'Test Show', persona: { id: 'persona a/b' } },
    {},
    { fetch: async (url) => {
      assert.equal(url, 'http://companion.test/gossip.rss?show=Test%20Show&actor=persona%20a%2Fb');
      return { ok: true, text: async () => xml };
    } },
    { feedUrl: 'http://companion.test' },
  );
  assert.equal(result.available, true);
  assert.deepEqual(result.items[0], {
    text: 'Alpha & Beta heard the cart skip twice',
    guid: 'rumor-1',
    pubDate: 'Sat, 19 Sep 2026 02:00:00 GMT',
    teller: 'Alpha & Crew',
  });
});

test('skill uses the configured feed URL and does not invent a host', async () => {
  const skill = await readFile(new URL('../skills/station-gossip/SKILL.md', import.meta.url), 'utf8');
  assert.doesNotMatch(skill, /10\.10\.1\.50/);
  const configured = 'http://gossip.example:8787';
  const result = await runGossipSkill(
    { show: 'Stahlwerk' },
    {},
    { fetch: async (url) => {
      assert.equal(url, 'http://gossip.example:8787/gossip.rss?show=Stahlwerk');
      return { ok: true, text: async () => '<rss version="2.0"><channel><item><description>Word is the condenser hums</description></item></channel></rss>' };
    } },
    { feedUrl: configured },
  );
  assert.equal(result.available, true);
  const missing = await runGossipSkill({ show: 'Stahlwerk' }, {}, { fetch: async () => { throw new Error('should not fetch'); } }, {});
  assert.deepEqual(missing, { available: false });
});

test('skill instructions mutate one detail in character and never narrate drift', async () => {
  const skill = await readFile(new URL('../skills/station-gossip/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /Choose one item from the tool/);
  assert.match(skill, /Change exactly one concrete detail/);
  assert.match(skill, /verified teller name/);
  assert.match(skill, /Use only identities the tool supplies/);
  assert.match(skill, /say nothing/);
  assert.match(skill, /no comparison to any earlier telling/);

  const source = 'Alpha heard the cart skip twice behind the booth.';
  const spoken = 'Word on the overnight shift is the cart skipped twice behind the mic stand.';
  assert.notEqual(spoken, source);
  assert.match(spoken, /cart skip/i);
  assert.doesNotMatch(spoken, /chang|drift|version|mixed up|earlier|before/i);
  assert.match(spoken, /mic stand/);
  assert.doesNotMatch(spoken, /booth/);
});
