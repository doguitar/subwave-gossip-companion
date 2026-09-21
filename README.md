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

curl -fsSL https://raw.githubusercontent.com/doguitar/subwave-gossip-companion/main/unraid/my-subwave-gossip-companion.xml \
  -o /boot/config/plugins/dockerMan/templates-user/my-subwave-gossip-companion.xml
```

Then open **Docker → Add Container**, choose the `subwave-gossip-companion` template, enter the Subwave and LLM credentials, and apply. The default host/container port is `8080`; persistent files use `/mnt/user/appdata/subwave-gossip-companion`.
