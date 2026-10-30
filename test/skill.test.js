import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import runGossipSkill from '../skills/station-gossip/tool.mjs';
import runCohostedGossipSkill from '../skills/station-gossip-cohosted/tool.mjs';

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
  assert.equal(result.items[0].rumor, 'Word is the cart skipped');
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
    rumor: 'Alpha & Beta heard the cart skip twice',
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

test('skill config label and install guide match the tool contract', async () => {
  const [{ configFields }, skillDoc, readme] = await Promise.all([
    import('../skills/station-gossip/tool.mjs'),
    readFile(new URL('../docs/skills.md', import.meta.url), 'utf8'),
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
  ]);
  assert.equal(configFields.feedUrl.label, 'Gossip feed URL');
  assert.doesNotMatch(configFields.feedUrl.label, /UPDG/);
  assert.match(readme, /docs\/skills\.md/);
  assert.match(skillDoc, /station-gossip-cohosted/);
  assert.match(skillDoc, /"available": false/);
  assert.match(skillDoc, /item\.rumor|`rumor`/);
  assert.match(skillDoc, /feedUrl is not configured/);
});

test('skill instructions escalate the rumor in character and never narrate drift', async () => {
  const skill = await readFile(new URL('../skills/station-gossip/SKILL.md', import.meta.url), 'utf8');
  const cohostedSkill = await readFile(new URL('../skills/station-gossip-cohosted/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /Take the first item/);
  assert.match(skill, /stay silent/);
  assert.match(skill, /item\.rumor/);
  assert.match(skill, /only version you have ever heard/);
  assert.match(skill, /Never refer to your active persona name in the third person/);
  for (const text of [skill, cohostedSkill]) {
    assert.match(text, /item\.rumor/);
    assert.match(text, /didn't just/);
    assert.match(text, /more grandiose/);
    assert.match(text, /maximum 40 words/);
    assert.match(text, /explicitly names your persona/);
    assert.match(text, /never claim you caused, own, or suffered/);
    assert.match(text, /Name only the people explicitly mentioned/);
    assert.doesNotMatch(text, /more salacious|ties this rumor to the last telling/);
  }

  const source = 'Alpha heard the cart skip twice behind the booth.';
  const spoken = 'Word on the overnight shift is the cart machine threw itself through the booth wall and took the transmitter with it.';
  assert.notEqual(spoken, source);
  assert.match(spoken, /cart/i);
  assert.doesNotMatch(spoken, /chang|drift|version|mixed up|earlier|before/i);
  assert.match(spoken, /transmitter/);
  assert.doesNotMatch(spoken, /skip twice/);
  const reed = 'I heard the gastropod colonized the master bus. The slime dissolved the analog routing, and I suspect the creature is the only thing keeping us on the air.';
  assert.match(reed, /colonized the master bus/);
  assert.match(reed, /dissolved the analog routing/);
  assert.match(reed, /only thing keeping us on the air/);
  assert.match(reed, /I suspect/);
  assert.doesNotMatch(reed, /didn't just|undersold|understat|not just|the word is|I think it was more/i);
  const sadie = 'I heard the slug digested the master bus and is broadcasting a manifesto with its glowing guts.';
  assert.match(sadie, /digested the master bus/);
  assert.match(sadie, /manifesto/);
  assert.doesNotMatch(sadie, /not just a handful of faders anymore|didn't just|understat|the word is|I think it was more/i);
  const werner = 'I heard Riff Reaper say the mic was vibrating scrap from the engine room.';
  assert.match(werner, /scrap from the engine room/);
  assert.match(werner, /Riff Reaper say/);
  assert.doesNotMatch(werner, /I think it was more|didn't just|not just|understat|the word is/i);
});

test('cohosted skill exposes the same structured rumor contract', async () => {
  const xml = '<rss version="2.0"><channel><item><guid>abc</guid><description>Cart rumor</description><gossipTeller>Alpha</gossipTeller><gossipHearers>Beta, Gamma</gossipHearers></item></channel></rss>';
  const result = await runCohostedGossipSkill(
    { show: 'Test Show' },
    {},
    { fetch: async () => ({ ok: true, text: async () => xml }) },
    { feedUrl: 'http://companion.test' },
  );
  assert.deepEqual(result.items, [{
    rumor: 'Cart rumor',
    text: 'Cart rumor',
    guid: 'abc',
    teller: 'Alpha',
    hearers: 'Beta, Gamma',
  }]);
});
