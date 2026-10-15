function words(value) {
  return String(value || '').toLowerCase().match(/[a-z0-9']+/g) || [];
}

export function matchSpokenTidbit(items, spokenText) {
  const text = String(spokenText || '');
  if (!text || !items?.length) return null;
  const byText = items.filter((it) => it.text && (text.includes(it.text) || it.text.includes(text)));
  if (byText.length === 1) return byText[0];
  return null;
}

export function matchVoicedTidbit(items, spokenText) {
  const exact = matchSpokenTidbit(items, spokenText);
  if (exact) return exact;
  const spokenWords = words(spokenText);
  if (spokenWords.length < 8) return null;
  const spokenSet = new Set(spokenWords);
  let best = null;
  let bestScore = 0;
  let tied = false;
  for (const item of items || []) {
    const itemWords = words(item?.text);
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
