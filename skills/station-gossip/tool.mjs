export const description = 'Read current show-known station gossip from the companion RSS feed.';

export const configFields = {
  feedUrl: {
    type: 'string',
    label: 'UPDG Gossip',
    hint: 'http://10.10.1.50:8787',
  },
};

function feedUrl(baseUrl, showTitle) {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  return `${root}/gossip.rss?show=${encodeURIComponent(showTitle)}`;
}

function asShowTitle(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object') {
    const name = value.name || value.title || value.show;
    if (typeof name === 'string' && name.trim()) return name.trim();
  }
  return '';
}

function resolveShow(ctx = {}, services = {}, config = {}) {
  const candidates = [
    ctx.show,
    ctx.showTitle,
    ctx.currentShow,
    ctx.activeShow,
    ctx.showHandover,
    ctx.session?.show,
    ctx.context?.show,
    services.context?.show,
    services.session?.show,
    config.show,
  ];
  for (const value of candidates) {
    const title = asShowTitle(value);
    if (title) return title;
  }
  return '';
}

function parseRssItems(xml) {
  if (!xml || !String(xml).includes('<rss')) return [];
  const items = [];
  const blocks = String(xml).split(/<item>/i).slice(1);
  for (const block of blocks) {
    const description = unescapeXml(matchTag(block, 'description'));
    if (!description) continue;
    items.push({ text: description });
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

async function getText(fetchImpl, url) {
  const res = await fetchImpl(url);
  if (!res || !res.ok) {
    const err = new Error(`HTTP ${res?.status || 0}`);
    err.status = res?.status;
    throw err;
  }
  return res.text();
}

export default async function (ctx = {}, _state, services = {}, config = {}) {
  const show = resolveShow(ctx, services, config);
  const baseUrl = config.feedUrl || config.companionUrl || config.feed || 'http://10.10.1.50:8787';
  const log = services.log || console.log;
  if (!show) {
    log?.(`[station-gossip] no show in context keys=${Object.keys(ctx || {}).join(',')}`);
    return { available: false };
  }
  const url = feedUrl(baseUrl, show);
  log?.(`[station-gossip] fetching ${url}`);
  try {
    let xml;
    try {
      xml = await getText(services.fetch || fetch, url);
    } catch (first) {
      if (services.fetch) xml = await getText(fetch, url);
      else throw first;
    }
    const items = parseRssItems(xml);
    if (!items.length) {
      log?.('[station-gossip] feed empty');
      return { available: false };
    }
    return { available: true, items };
  } catch (err) {
    log?.(`[station-gossip] fetch failed: ${err.message || err}`);
    return { available: false };
  }
}
