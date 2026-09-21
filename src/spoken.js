export function matchSpokenTidbit(items, spokenText) {
  const text = String(spokenText || '');
  if (!text || !items?.length) return null;
  const byText = items.filter((it) => it.text && (text.includes(it.text) || it.text.includes(text)));
  if (byText.length === 1) return byText[0];
  return null;
}
