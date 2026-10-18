# Subwave Gossip Companion

A persona-aware fictional gossip companion for SUB/WAVE. It generates linked telephone-game tidbits, serves an RSS feed for the station skill, ingests spoken events, and supports OpenAI-compatible, Google Gemini, and Anthropic LLM providers.

## Configuration

Copy `.env.example` to `.env` and set the Subwave credentials and LLM provider:

```dotenv
SUBWAVE_API_URL=https://your-station.example/api
SUBWAVE_API_USER=admin
SUBWAVE_API_PASSWORD=secret
PROVIDER=openai
PROVIDER_KEY=...
PROVIDER_MODEL=gpt-4o-mini
OPENAI_BASE_URL=https://api.openai.com/v1
```

`GOSSIP_BASE_DIR` is the runtime data root. Relative state, prompt, and call-log paths resolve below it. The prompt is external configuration at `GOSSIP_PROMPT_PATH` and defaults to `prompt.md` below the base directory.

## Station house rules and persona context

The companion fetches the station's current context from the Subwave admin API on each seed or refresh request:

1. Open **Admin → Personas → System Prompt** in Subwave and maintain the station-wide house rules.
2. Maintain general persona information in each persona's system prompt/soul, including voice, personality, background, speech habits, recurring interests, avoidances, and relationships that are useful for fictional station banter.
3. The companion reads the station rules from the admin settings field `values.djHouseRules`.
4. It reads the persona roster and each persona's `soul` from `values.personas`.
5. Both are inserted into the user prompt sent to the configured LLM provider for every generated tidbit.

The request includes a `DJ house rules` block and a `Station souls` block. Updating these fields in Subwave changes subsequent generations; no code or prompt-file edit is required. Keep secrets and real private-person information out of the house rules and persona souls.

## Local usage

```bash
npm install
npm test
node src/cli.js serve --base-dir .
node src/cli.js refresh --base-dir .
```

The HTTP service listens on `GOSSIP_HOST:GOSSIP_PORT` and exposes `/gossip.rss` and `POST /gossip/refresh`.

### Character-aware RSS

`GET /gossip.rss` requires `show`. The feed contains rumors known to that show's personas: public tidbits, tidbits told by someone on the show, and tidbits heard by someone on the show. Pass the speaking persona id as `actor` so the station skill can request that character's feed:

```bash
curl "http://127.0.0.1:8080/gossip.rss?show=Island%20Time&actor=p_79eaff"
```

With `actor`, the feed includes every known rumor except one whose newest comment on that show was made by the requesting actor. If that exclusion removes the only item, the feed is empty. Rumors nobody has commented on come first; previously commented rumors follow, oldest comment first. Without `actor`, the feed keeps show-known order and records nothing. An unknown show returns an empty feed. A missing `show` returns 400.

Set `GOSSIP_FEED_BASE_URL` to the public URL the station skill uses to fetch gossip (see `.env.example`). When it is set, RSS channel and item `<link>` values use that base with the same `show` and optional `actor` query parameters as the request. When it is unset, links use the incoming request URL.

Item text stays the plain rumor. Stable ids are the RSS GUIDs. When the teller is on the requested show, the item also includes an escaped `<gossipTeller>` display name. Hearer identities and persona ids are not emitted.

A comment is `{id, tidbitId, actorPersonaId, show, commentedAt}`. Spoken events with an actor id record one when the line matches a tidbit. After a skill fetch, the TTS follow-up resolves the speaker from a persona id or display name and records the same kind of comment on the source rumor and the on-air tidbit. Fetches alone do not mark a rumor as voiced. The store keeps the newest 1000 comments.

### Refreshing gossip

The CLI refresh replaces the current board with a new linked set of tidbits:

```bash
node src/cli.js refresh --base-dir .
```

For a deployed instance, call the HTTP endpoint with `POST`. The request body is optional:

```bash
curl -i -X POST http://127.0.0.1:8080/gossip/refresh
```

If Docker maps host port `8095` to container port `8080`, use the host port:

```bash
curl -i -X POST http://127.0.0.1:8095/gossip/refresh
```

The same endpoint is available at `/refresh`:

```bash
curl -i -X POST http://127.0.0.1:8095/refresh
```

The response is JSON containing the generated tidbits and generation status. Refresh requires the configured Subwave credentials and LLM provider settings.

## Docker

The image keeps application code in `/app` and runtime configuration/state in `/workspace`:

```bash
docker build -t subwave-gossip-companion .
docker run --rm -p 8787:8787 \
  --env-file /path/to/gossip.env \
  -v /path/to/gossip-workspace:/workspace \
  subwave-gossip-companion
```

Put `prompt.md` in the mounted workspace, or set `GOSSIP_PROMPT_PATH` to another mounted path. The container sets `GOSSIP_BASE_DIR=/workspace` and starts the server with that base directory. Persist `/workspace` to retain the gossip state and LLM call log.

## GitHub Container Registry

The GitHub Actions workflow publishes `ghcr.io/<owner>/subwave-gossip-companion` on pushes to `main` and on version tags. Pull requests run the tests and build the image without publishing.

## Scheduled commands

Use the included `crontab` for daily seeding and recurring spoken-event ingestion, adding `--base-dir` to point at the persistent runtime directory when deployed outside Docker.

## Unraid

Install the container template directly into the Community Applications templates directory:

```bash
curl -fsSL https://raw.githubusercontent.com/doguitar/subwave-gossip-companion/main/unraid/my-subwave-gossip-companion.xml \
  -o /boot/config/plugins/dockerMan/templates-user/my-subwave-gossip-companion.xml
```

Then open **Docker → Add Container**, choose the `subwave-gossip-companion` template, enter the Subwave and LLM credentials, and apply. The default host/container port is `8080`; persistent files use `/mnt/user/appdata/subwave-gossip-companion`.
