export const description = 'Read current show-known station gossip from the companion RSS feed.';

export const configFields = {
  feedUrl: {
    type: 'string',
    label: 'Gossip feed URL',
    hint: 'http://192.168.1.20:8080',
  },
};

function feedUrl(baseUrl, showTitle, actorPersonaId) {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  let url = `${root}/gossip.rss?show=${encodeURIComponent(showTitle)}`;
  if (actorPersonaId) url += `&actor=${encodeURIComponent(actorPersonaId)}`;
  return url;
}

function asId(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return '';
}

function resolveActor(ctx = {}, services = {}) {
  const candidates = [
    ctx.personaId,
    ctx.persona?.id,
    ctx.characterId,
    ctx.character?.id,
    ctx.actorPersonaId,
    services.context?.personaId,
  ];
  for (const value of candidates) {
    const id = asId(value);
    if (id) return id;
  }
  return '';
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
    const guid = matchTag(block, 'guid');
    const pubDate = matchTag(block, 'pubDate');
    const teller = unescapeXml(matchTag(block, 'gossipTeller'));
    const hearers = unescapeXml(matchTag(block, 'gossipHearers'));
    const item = { rumor: description, text: description };
    if (guid) item.guid = guid;
    if (pubDate) item.pubDate = pubDate;
    if (teller) item.teller = teller;
    if (hearers) item.hearers = hearers;
    items.push(item);
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
  const log = services.log || console.log;
  const baseUrl = String(config.feedUrl || config.companionUrl || config.feed || '').trim();
  if (!baseUrl) {
    log?.('[station-gossip] feedUrl is not configured');
    return { available: false };
  }
  if (!show) {
    log?.(`[station-gossip] no show in context keys=${Object.keys(ctx || {}).join(',')}`);
    return { available: false };
  }
  const actor = resolveActor(ctx, services);
  if (!actor) {
    log?.(`[station-gossip] no actor persona id in context keys=${Object.keys(ctx || {}).join(',')}; feed will not rotate per character`);
  }
  const url = feedUrl(baseUrl, show, actor);
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
