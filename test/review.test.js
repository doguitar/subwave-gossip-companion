import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyReviewRevisions, reviewGossipBatch } from '../src/review.js';
import { PERSONA_A, PERSONA_B, PERSONA_C } from './helpers.js';

const roles = {
  teller: PERSONA_A,
  hearers: [PERSONA_B],
  targets: [PERSONA_C],
};
const register = { id: 'wacky', name: 'wacky', guidance: 'physical station chaos' };
const original = 'word is Gamma hid a cart behind the legal ID again';

function candidate(id = 'review-1') {
  return {
    id,
    text: `Alpha told Beta, "${original}"`,
    tellerPersonaId: PERSONA_A.id,
    hearerPersonaIds: [PERSONA_B.id],
  };
}

test('review uses canonical targets rather than names inferred from rendered text', () => {
  const tidbit = candidate();
  const result = applyReviewRevisions(
    [tidbit],
    new Map([[tidbit.id, 'Alpha hid a cart behind the legal ID again']]),
    new Map([[tidbit.id, { roles, register }]]),
  );
  assert.equal(result.rejected, 1);
  assert.equal(result.stale, 1);
  assert.equal(result.tidbits[0].text, tidbit.text);
});

test('review rejects generic eyewitness and now-aftermath revisions but allows an immediate reaction', () => {
  const tidbit = candidate();
  const metadata = new Map([[tidbit.id, { roles, register }]]);
  for (const rumor of [
    'Word is I walked past Gamma hiding a cart behind the legal ID again',
    'Gamma hid a cart behind the legal ID. Now it is on permanent display',
  ]) {
    const result = applyReviewRevisions([tidbit], new Map([[tidbit.id, rumor]]), metadata);
    assert.equal(result.rejected, 1);
  }
  const accepted = 'Gamma hid a cart behind the legal ID and Gamma yelped when the booth light flashed';
  const result = applyReviewRevisions([tidbit], new Map([[tidbit.id, accepted]]), metadata);
  assert.equal(result.accepted, 1);
  assert.equal(result.tidbits[0].text, `Alpha told Beta, "${accepted}"`);
});

test('review requires whole canonical target names and rejects self-target metadata', () => {
  const tidbit = candidate();
  const metadata = new Map([[tidbit.id, { roles, register }]]);
  const substring = applyReviewRevisions(
    [tidbit],
    new Map([[tidbit.id, 'Gammas hid a cart behind the legal ID again']]),
    metadata,
  );
  assert.equal(substring.rejected, 1);

  const selfTarget = applyReviewRevisions(
    [tidbit],
    new Map([[tidbit.id, 'Alpha hid a cart behind the legal ID again']]),
    new Map([[tidbit.id, { roles: { ...roles, targets: [PERSONA_A] }, register }]]),
  );
  assert.equal(selfTarget.rejected, 1);
});

test('review retains its accepted baseline after a rejected later revision', () => {
  const tidbit = candidate();
  const metadata = new Map([[tidbit.id, { roles, register }]]);
  const accepted = 'Gamma stashed a cart behind the legal ID for laughs';
  const first = applyReviewRevisions([tidbit], new Map([[tidbit.id, accepted]]), metadata);
  const second = applyReviewRevisions(first.tidbits, new Map([[tidbit.id, 'string']]), metadata);
  assert.equal(second.rejected, 1);
  assert.equal(second.stale, 0);
  assert.equal(second.tidbits[0].text, `Alpha told Beta, "${accepted}"`);
});

test('review batch marks missing canonical metadata stale and reports outcomes', async () => {
  const tidbit = candidate();
  const result = await reviewGossipBatch({
    tidbits: [tidbit],
    rolesById: new Map(),
    roster: [PERSONA_A, PERSONA_B, PERSONA_C],
    reviewRounds: 1,
    generateReview: async () => ({ rumors: { [tidbit.id]: 'Gamma hid a cart behind the legal ID again' } }),
    log: { info() {}, warn() {} },
  });
  assert.deepEqual(
    { accepted: result.accepted, rejected: result.rejected, stale: result.stale },
    { accepted: 0, rejected: 0, stale: 1 },
  );
});
