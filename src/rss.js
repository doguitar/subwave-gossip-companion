import { createHash } from 'node:crypto';

export const FEED_TITLE = 'Station Gossip';

export function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function toRfc822(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return new Date().toUTCString();
  return d.toUTCString();
}

export function itemGuid(item) {
  if (item?.id) return String(item.id);
  return createHash('sha1').update(`${item?.text || ''}\0${item?.createdAt || ''}`).digest('hex');
}

export function buildRss({ items, title = FEED_TITLE, link = '' }) {
  const itemXml = items
    .map((item) => {
      const itemLink = item.link || link;
      return [
        '    <item>',
        `      <title>${escapeXml(item.text)}</title>`,
        `      <description>${escapeXml(item.text)}</description>`,
        itemLink ? `      <link>${escapeXml(itemLink)}</link>` : null,
        `      <guid isPermaLink="false">${escapeXml(itemGuid(item))}</guid>`,
        `      <pubDate>${escapeXml(toRfc822(item.createdAt))}</pubDate>`,
        '    </item>',
      ].filter(Boolean).join('\n');
    })
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    '  <channel>',
    `    <title>${escapeXml(title)}</title>`,
    link ? `    <link>${escapeXml(link)}</link>` : null,
    `    <description>${escapeXml(FEED_TITLE)}</description>`,
    itemXml,
    '  </channel>',
    '</rss>',
    '',
  ].filter((line) => line !== null).join('\n');
}

export function parseRssItems(xml) {
  if (!xml || !String(xml).includes('<rss')) return [];
  const items = [];
  const blocks = String(xml).split(/<item>/i).slice(1);
  for (const block of blocks) {
    const guid = matchTag(block, 'guid');
    const description = unescapeXml(matchTag(block, 'description'));
    if (!guid || !description) continue;
    items.push({ id: guid, text: description });
  }
  return items;
}

function matchTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

function unescapeXml(value) {
  return String(value)
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}
