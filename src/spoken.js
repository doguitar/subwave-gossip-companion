import { retellableRumor } from './validate.js';

function words(value) {
  return String(value || '').toLowerCase().match(/[a-z0-9']+/g) || [];
}

export function matchSpokenTidbits(items, spokenText) {
  const text = retellableRumor(String(spokenText || ''));
  if (!text || !items?.length) return [];
  return items.filter((it) => {
    const rumor = retellableRumor(it.text);
    return rumor && (text.includes(rumor) || rumor.includes(text));
  });
}

export function matchSpokenTidbit(items, spokenText) {
  const hits = matchSpokenTidbits(items, spokenText);
  return hits.length === 1 ? hits[0] : null;
}

export function matchVoicedTidbit(items, spokenText) {
  const exact = matchSpokenTidbit(items, spokenText);
  if (exact) return exact;
  const spokenWords = words(retellableRumor(spokenText));
  if (spokenWords.length < 8) return null;
  const spokenSet = new Set(spokenWords);
  let best = null;
  let bestScore = 0;
  let tied = false;
  for (const item of items || []) {
    const itemWords = words(retellableRumor(item?.text));
    if (itemWords.length < 8) continue;
    const shared = itemWords.filter((word) => spokenSet.has(word)).length;
    const score = shared / Math.min(itemWords.length, spokenWords.length);
    if (score > bestScore + 0.02) {
      best = item;
      bestScore = score;
      tied = false;
    } else if (Math.abs(score - bestScore) <= 0.02 && score >= 0.55) {
      tied = true;
    }
  }
  if (tied || bestScore < 0.55) return null;
  return best;
}
