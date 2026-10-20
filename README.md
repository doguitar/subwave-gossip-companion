# Subwave Gossip Companion

A persona-aware fictional gossip companion for SUB/WAVE. It generates linked telephone-game tidbits, serves an RSS feed for the station skill, ingests spoken events, and supports OpenAI-compatible, Google Gemini, and Anthropic LLM providers.

## Configuration

Copy `.env.example` to `.env` and set the Subwave credentials and LLM provider:

```dotenv
GOSSIP_BASE_DIR=.
GOSSIP_TYPES_PATH=gossip-types.json
SUBWAVE_API_URL=https://your-station.example/api
SUBWAVE_API_USER=admin
SUBWAVE_API_PASSWORD=secret
PROVIDER=openai
PROVIDER_KEY=...
PROVIDER_MODEL=gpt-4o-mini
OPENAI_BASE_URL=https://api.openai.com/v1
PROVIDER_THINKING=
GOSSIP_REVIEW_ROUNDS=0
```

`PROVIDER_THINKING` (or `GOSSIP_LLM_THINKING`) optionally steers provider thinking/reasoning depth for seed-generation LLM calls. When unset or blank after trim, thinking is off and outgoing request bodies match the pre-thinking defaults. When set to any non-empty string, that value is passed through to the provider (for example `low`, `medium`, `high`, `max`, or tokens your local proxy understands) without validation.

`GOSSIP_REVIEW_ROUNDS` (default `0`, range `0`–`5`) runs optional post-generation edit passes after a successful seed or refresh batch. Each round sends every tidbit from that batch to the LLM to make the rumor coherent and to cut non-sequiturs, without adding facts; teller/hearer persona ids and the told/said-on-air wrapper stay fixed. Higher values add latency and LLM cost. At `0`, behavior matches pre-review releases (no extra model calls).

`GOSSIP_BASE_DIR` is the runtime data root. Relative state, prompt, gossip-type catalog, call-log, and operational-log paths resolve below it. The system prompt is always read from `prompt.md` in the workspace. On each start, the image-bundled prompt is written to `prompt.md.default` (overwriting any prior snapshot so upgrades refresh the reference copy without changing your live `prompt.md`). If `prompt.md` is missing or empty, it is seeded from that default before configuration loads. When trimmed `prompt.md` differs from trimmed `prompt.md.default`, startup emits one `[gossip]` warning line to the operational log (and console tee). Comic rumor registers (gossip types) live in `GOSSIP_TYPES_PATH` (default `gossip-types.json` under the base directory): a JSON array of objects with `slug` and `guidance` (optional `name`; otherwise the slug is humanized for display). Optional `targetCount` (non-negative integer, at most `2`) limits a register to rumors with exactly that many rumor-targets: use `0` for station-life bits with no named targets, `2` for two-target feud registers, or omit the field to allow any target count (default behavior). On first run, if that file is missing, the companion writes the same four built-in registers shipped with the image. Duplicate slugs or an empty catalog fail startup. Operational `[gossip]` lines tee to stdout/stderr and append to `GOSSIP_OPERATIONAL_LOG` (default `logs/gossip.log`); each line is one physical log event with no embedded newlines. Accepted tidbits and review text changes (before→after quoted rumor) are echoed at `info` when generation or review succeeds; seed/review HTTP calls still log only one-line start summaries. Full system and user prompts for each LLM call are recorded in the active LLM call log (`GOSSIP_LLM_CALL_LOG`, default `logs/llm-calls.jsonl`), which rolls to a timestamped sibling when an append would exceed 512 KiB, and rolled segments older than seven days are removed on each write.

## Station house rules and persona context

The companion fetches the station's current context from the Subwave admin API on each seed or refresh request:

1. Open **Admin → Personas → System Prompt** in Subwave and maintain the station-wide house rules.
2. Maintain general persona information in each persona's system prompt/soul, including voice, personality, background, speech habits, recurring interests, avoidances, and relationships that are useful for fictional station banter.
3. The companion reads the station rules from the admin settings field `values.djHouseRules`.
4. It reads the persona roster and each persona's `soul` from `values.personas`.
5. Once per seed, refresh, or generate, the companion summarizes the house rules and each persona soul into the parts a rumor needs, then inserts those summaries into the user prompt. Soul summaries keep identity, one speech tic, booth habits, props, and relationships. The house-rules summary keeps the station setting, the audience, and language limits.
6. For each rumor, the companion picks one comic register from the loaded gossip-types catalog and adds a `Rumor register for this rumor` block to that user prompt (`display name — guidance`). The system prompt defers register choice to this block. Edit `gossip-types.json` (or set `GOSSIP_TYPES_PATH`) to add types or change guidance without redeploying code.
7. The seed user prompt names the rumor-targets and does not prescribe a two-target sentence shape. Prior rumors are not pasted into the user prompt.

The request includes the house-rules summary, persona summaries, and (per rumor) the register block. Updating house rules or persona souls in Subwave changes subsequent generations; no code or prompt-file edit is required. Keep secrets and real private-person information out of the house rules and persona souls.

## Local usage

```bash
npm install
npm test
node src/cli.js serve --base-dir .
node src/cli.js refresh --base-dir .
node src/cli.js generate --base-dir . --reasoning low --review-steps 1
node src/cli.js summarize-souls --base-dir .
```

`generate` seeds the board the same way as `seed`, prints each new rumor, and accepts `--reasoning` (one run's thinking level) and `--review-steps` (an integer 0–5 for that run). `summarize-souls` prints the house-rules summary and each persona summary without writing gossip. Soul and house-rules summary calls are written to the LLM call log with the same redaction as seed and review.

The HTTP service listens on `GOSSIP_HOST:GOSSIP_PORT` and exposes `/gossip.rss` and `POST /gossip/refresh`.

### Character-aware RSS

`GET /gossip.rss` requires `show`. The feed contains rumors known to that show's personas: public tidbits, tidbits told by someone on the show, and tidbits heard by someone on the show. Pass the speaking persona id as `actor` so the station skill can request that character's feed:

```bash
curl "http://127.0.0.1:8080/gossip.rss?show=Island%20Time&actor=p_79eaff"
```

With `actor`, the feed lists one item per rumor subject (escalation chains count as one subject). It includes every subject except one whose newest comment on that show was made by the requesting actor on that subject's root tidbit. If that exclusion removes the only subject, the feed is empty. Subjects nobody has commented on come first (newest root first among them); previously commented subjects follow, oldest comment first. Without `actor`, the feed lists one item per subject ordered by root tidbit age (oldest subject first) so a fresh escalation tidbit does not jump ahead of other subjects. An unknown show returns an empty feed. If the Subwave schedule cannot be loaded, the response is a non-2xx JSON error instead of RSS. A missing `show` returns 400.

Set `GOSSIP_FEED_BASE_URL` to the public URL the station skill uses to fetch gossip (see `.env.example`). When it is set, RSS channel and item `<link>` values use that base with the same `show` and optional `actor` query parameters as the request. When it is unset, links use the incoming request URL.

Item text stays the plain rumor. Stable ids are the RSS GUIDs. When the teller is on the requested show, the item also includes an escaped `<gossipTeller>` display name. Hearer identities and persona ids are not emitted.

A comment is `{id, tidbitId, actorPersonaId, show, commentedAt}`. Spoken events with an actor id record one when the line matches a tidbit. After a non-empty gossip RSS response, the TTS follow-up runs whether or not the request included `actor` (`actor` only shapes feed rotation and exclusion). The follow-up resolves the speaker from a persona id or display name and records the same kind of comment on the source rumor and the on-air tidbit. Fetches alone do not mark a rumor as voiced. The store keeps the newest 1000 comments.

### Refreshing gossip

The CLI refresh replaces the current board with a new linked set of tidbits. On a successful refresh, gossip comments whose `tidbitId` is not on the new board are removed; a failed refresh leaves comments unchanged.

During one refresh, each successfully appended rumor uses a distinct rumor-target persona set—the unordered persona IDs in `roles.targets`, including the empty set when there are zero targets. The refresh loop resamples role picks up to a small retry budget when a set would repeat; only accepted tidbits reserve a set, and deduplication is scoped to that batch only (not prior days or generated history).

On the default refresh path (no injected role picker), the loop keeps generating until every roster persona has appeared as teller or hearer on at least one accepted rumor and as a rumor-target on at least one accepted rumor. Empty target sets do not count toward target coverage. Refreshes that inject a fixed role picker or use a low link cap skip that completeness check. If the link budget is exhausted before both conditions hold, the refresh fails with no successful board replacement, same as an incomplete telephone chain.

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

Put `prompt.md` and `gossip-types.json` in the mounted workspace, or set `GOSSIP_TYPES_PATH` to another path under the mount. The entrypoint refreshes `prompt.md.default` on every start and seeds `prompt.md` when it is missing or empty; the Node process applies the same rules for non-Docker runs. It sets `GOSSIP_BASE_DIR=/workspace` and starts the server with that base directory. Persist `/workspace` to retain gossip state, operator prompt/types files, the operational log, and the LLM call log.

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