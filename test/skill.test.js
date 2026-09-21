import assert from 'node:assert/strict';
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
