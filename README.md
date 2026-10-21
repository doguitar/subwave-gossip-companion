# Subwave Gossip Companion

A persona-aware fictional gossip companion for SUB/WAVE. A seed or refresh batch writes independent tidbits, each with its own teller, rumor-targets, and comic register. It does not retell the previous batch item. Telephone-game escalation happens later, when on-air follow-up records a spoken telling against an existing rumor thread. The companion serves an RSS feed for the station skill, ingests spoken events, and supports OpenAI-compatible, Google Gemini, and Anthropic LLM providers.

Commands, HTTP routes, environment keys, and privacy are in [docs/reference.md](docs/reference.md). Contributor routing is in [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md). This page keeps the operating narrative; that page is the table of what the process actually accepts.

## Configuration

Copy `.env.example` to `.env` and set the Subwave credentials and LLM provider. With no `--base-dir`, the CLI loads `./.env`. If `GOSSIP_BASE_DIR` is already set, it loads `$GOSSIP_BASE_DIR/.env` instead. `--base-dir` wins over that variable and loads `<base-dir>/.env`. A missing file is ignored; any other read error names the path and stops startup.

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
GOSSIP_REFRESH_SECRET=use-a-long-random-operator-secret
GOSSIP_REFRESH_MAX_CONCURRENCY=1
GOSSIP_REFRESH_MIN_INTERVAL_MS=60000
GOSSIP_REFRESH_BODY_MAX_BYTES=16384
GOSSIP_HEADERS_TIMEOUT_MS=10000
GOSSIP_REQUEST_TIMEOUT_MS=30000
GOSSIP_SHUTDOWN_DEADLINE_MS=5000
GOSSIP_REVIEW_ROUNDS=0
GOSSIP_THREAD_MAX_TELLINGS=3
GOSSIP_THREAD_MAX_AGE_MS=86400000
```

`PROVIDER_THINKING` (or `GOSSIP_LLM_THINKING`) optionally steers provider thinking/reasoning depth for seed-generation LLM calls. When unset or blank after trim, thinking is off and outgoing request bodies match the pre-thinking defaults. When set to any non-empty string, that value is passed through to the provider (for example `low`, `medium`, `high`, `max`, or tokens your local proxy understands) without validation.

`GOSSIP_REVIEW_ROUNDS` (default `0`, range `0`–`5`) runs optional post-generation edit passes after a successful seed or refresh batch. Each round validates revisions against the canonical teller, hearer, target, and comic-register assignment made during generation; teller/hearer persona ids and the told/said-on-air wrapper stay fixed. Review logs and seed/refresh results report accepted, rejected, and stale candidates. Higher values add latency and LLM cost. At `0`, behavior matches pre-review releases (no extra model calls).

`GOSSIP_REFRESH_COUNT` (default `1`, range `1`–`10`) is the default maximum number of accepted tidbits for one refresh. `node src/cli.js refresh [count]` accepts the same range as a one-run override, and `POST /gossip/refresh` accepts it as JSON `{ "count": 1 }` or a `count` query parameter. Explicit invalid counts are rejected. A low count may return a successful roster-incomplete board; `refreshed` and `tidbits` always report only the accepted tidbits and never exceed the requested count.

`GOSSIP_REFRESH_SECRET` is required and is a dedicated operator credential for the HTTP refresh endpoints; it never falls back to Subwave or LLM credentials. Send it as `Authorization: Bearer <secret>`. `GOSSIP_REFRESH_MAX_CONCURRENCY` (default `1`, range `1`–`10`) bounds simultaneous admitted refreshes, and `GOSSIP_REFRESH_MIN_INTERVAL_MS` (default `60000`, range `0`–`3600000`) limits how frequently one process admits them. Rejected unauthenticated requests do not read a body or reload/generate gossip; requests exceeding either admission limit receive `429`.

`GOSSIP_REFRESH_BODY_MAX_BYTES` (default `16384`, range `1`–`1048576`) limits the JSON body accepted by `POST /refresh` and `POST /gossip/refresh`. Bodies whose declared `Content-Length` or streamed bytes exceed the limit receive `413 Payload Too Large` before gossip reload or generation begins. `GOSSIP_HEADERS_TIMEOUT_MS` (default `10000`, range `1000`–`300000`) limits header delivery, and `GOSSIP_REQUEST_TIMEOUT_MS` (default `30000`, range `1000`–`300000`) limits the complete HTTP request, including its body; both values are milliseconds.

`GOSSIP_SHUTDOWN_DEADLINE_MS` (default `5000`, range `0`–`3600000`) is how long `serve` keeps draining an admitted refresh or a follow-up watch after `SIGTERM` or `SIGINT`. `0` skips that wait. The orchestrator stop grace has to be strictly longer than the deadline plus the five-second exclusive state-lock wait. Docker's default grace of 10 seconds is not long enough for the default deadline: set it to at least 15 seconds (`docker run --stop-timeout`, `docker stop --time`, Compose `stop_grace_period`). Unraid uses Docker's stop grace and needs the same setting.

`GOSSIP_THREAD_MAX_TELLINGS` (default `3`, range `1`–`100`) and `GOSSIP_THREAD_MAX_AGE_MS` (default `86400000`) retire a thread from RSS selection after its attributed on-air telling count or age reaches the configured limit. RSS item shape remains unchanged.

`GOSSIP_BASE_DIR` is the runtime data root. Relative state, prompt, gossip-type catalog, call-log, and operational-log paths resolve below it. The system prompt is always read from `prompt.md` in the workspace. On each start, the image-bundled prompt is written to `prompt.md.default` (overwriting any prior snapshot so upgrades refresh the reference copy without changing your live `prompt.md`). If `prompt.md` is missing or empty, it is seeded from that default before configuration loads. When trimmed `prompt.md` differs from trimmed `prompt.md.default`, startup emits one `[gossip]` warning line to the operational log (and console tee). Comic rumor registers (gossip types) live in `GOSSIP_TYPES_PATH` (default `gossip-types.json` under the base directory): a JSON array of objects with `slug` and `guidance` (optional `name`; otherwise the slug is humanized for display). Optional `targetCount` (non-negative integer, at most `2`) limits a register to rumors with exactly that many rumor-targets: use `0` for station-life bits with no named targets, `2` for two-target feud registers, or omit the field to allow any target count (default behavior). On first run, if that file is missing or empty, bare Node and the Docker entrypoint both copy the packaged `gossip-types.json` shipped with the image, so an empty workspace gets the same catalog either way. A non-empty workspace file is the live override: later starts and image upgrades leave it unchanged. Edit that file, or point `GOSSIP_TYPES_PATH` at another file under the workspace, to change types without rebuilding. Duplicate slugs or an empty catalog fail startup. Operational `[gossip]` lines tee to stdout/stderr and append to `GOSSIP_OPERATIONAL_LOG` (default `logs/gossip.log`); each line is one physical log event with no embedded newlines. `GOSSIP_OPERATIONAL_LOG_MAX_BYTES` (default `524288`, 512 KiB, range `1`–`1073741824`) caps that active file. When the next line would make it larger, the current bytes are renamed to `gossip.<milliseconds>.log` in the same directory, and the new line is written whole. A single line longer than the cap is still written whole, with no timestamp prefix. `GOSSIP_OPERATIONAL_LOG_RETENTION_MS` (default `604800000`, seven days, range `1`–`31536000000`) is how long a segment is kept. At startup, and again on each append, a segment whose modification time is older than that window is deleted. A segment still inside the window is left byte-for-byte. Accepted tidbits and review text changes (before→after quoted rumor) are echoed at `info` when generation or review succeeds; seed/review HTTP calls still log only one-line start summaries. Provider preflight, LLM-call, and follow-up lifecycle events use versioned JSON payloads and redact provider credentials from diagnostic details. LLM call diagnostics go to `GOSSIP_LLM_CALL_LOG` (default `logs/llm-calls.jsonl`). The file rolls to a timestamped sibling when an append would exceed 512 KiB. Records older than seven days are removed from the active file and from rolled segments at process startup, once an hour while `serve` is running, and after each append, so a stopped or idle process does not keep stale prompts until the next model call. Each JSON line keeps `version`, `at`, lifecycle and invocation ids, `kind`, `provider`, `model`, `retry`, `stage`, and when present `elapsedMs`, `status`, `usage`, and a redacted `detail`. `GOSSIP_LLM_LOG_CONTENT` is `metadata` by default and drops prompt, message, soul, house-rule, and response bodies. Set it to `full` only when you intentionally retain that content, or `off` to skip the call log. An empty `GOSSIP_LLM_CALL_LOG` also disables it. These files can contain provider errors and, in `full` mode, station fiction and persona text. Keep the log directory owner-readable (mode `0700` on the directory is enough for a single service user), exclude it from shared backups or encrypt the backup, and delete the `logs/` tree when handing a workspace to someone else.

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
node src/cli.js refresh 1 --base-dir .
node src/cli.js generate --base-dir . --reasoning low --review-steps 1
node src/cli.js summarize-souls --base-dir .
```

`generate` seeds the board the same way as `seed`, prints each new rumor, and accepts `--reasoning` (one run's thinking level) and `--review-steps` (an integer 0–5 for that run). `summarize-souls` prints the house-rules summary and each persona summary without writing gossip. Soul and house-rules summary calls are written to the LLM call log with the same redaction as seed and review.

The HTTP service listens on `GOSSIP_HOST:GOSSIP_PORT` and exposes `/gossip.rss` and `POST /gossip/refresh`. `GET /health` is the liveness probe and `GET /ready` is the readiness probe. The image healthcheck calls liveness only.

If the gossip state file is not valid JSON, startup exits non-zero and names that file. The default path is `data/gossip-state.json` under the base directory; `GOSSIP_STATE_PATH` selects a different file under that directory. The process does not rewrite the file. Stop the process, replace the file with a backup or repair the JSON in place with an external editor, then start again. Do not delete the file to get past the error if those bytes are still needed. A missing file is first-run behavior and comes up as an empty board.

### Character-aware RSS

`GET /gossip.rss` requires `show`. The feed contains rumors known to that show's personas: public tidbits, tidbits told by someone on the show, and tidbits heard by someone on the show. Pass the speaking persona id as `actor` so the station skill can request that character's feed:

```bash
curl "http://127.0.0.1:8080/gossip.rss?show=Island%20Time&actor=p_79eaff"
```

With `actor`, the feed lists one item per rumor subject (escalation chains count as one subject). It includes every subject except one whose newest comment on that show was made by the requesting actor on that subject's root tidbit. If that exclusion removes the only subject, the feed is empty. Subjects nobody has commented on come first (newest root first among them); previously commented subjects follow, oldest comment first. Without `actor`, the feed lists one item per subject ordered by root tidbit age (oldest subject first) so a fresh escalation tidbit does not jump ahead of other subjects. An unknown show returns an empty feed. If the Subwave schedule cannot be loaded, the response is a non-2xx JSON error instead of RSS. A missing `show` returns 400.

Set `GOSSIP_FEED_BASE_URL` to the public URL the station skill uses to fetch gossip (see `.env.example`). When it is set, RSS channel and item `<link>` values use that base with the same `show` and optional `actor` query parameters as the request. When it is unset, links use the incoming request URL.

Each item `<title>` and `<description>` contains the retellable rumor body. Stored corkboard attribution such as `Alice told Bob, "…"` remains in history but is removed from the feed body. Stable ids are the RSS GUIDs. When identities resolve on the requested show, the item includes escaped `<gossipTeller>` and comma-separated `<gossipHearers>` display names; persona ids are never emitted. Station-gossip skills consume the rumor body as `item.rumor`, with teller, optional hearers, GUID, and publication time as metadata.

A comment is `{id, tidbitId, actorPersonaId, show, commentedAt}`. Spoken events with an actor id record one when the line matches a tidbit. After a non-empty gossip RSS response, the TTS follow-up runs whether or not the request included `actor` (`actor` only shapes feed rotation and exclusion). The follow-up resolves the speaker from a persona id or display name and records the same kind of comment on the source rumor and the on-air tidbit. Fetches alone do not mark a rumor as voiced. That on-air follow-up is the telephone chain: it attributes a spoken telling to the matched thread and can escalate the same rumor. Seed and refresh do not pass a previous telling into the next generation. The store keeps the newest 1000 comments.

### Refreshing gossip

The CLI refresh replaces the current board with a new linked set of tidbits. On a successful refresh, gossip comments whose `tidbitId` is not on the new board are removed; a failed refresh leaves comments unchanged. Within one companion process, overlapping seed and refresh requests wait in FIFO order for the earlier generation and review cycle to finish. This can make a CLI or HTTP request wait for an earlier operation. Across processes, every gossip-state read-modify-write takes an exclusive lock on a sibling of the state file and re-reads before it writes, so overlapping incremental updates queue instead of dropping a committed tidbit, comment, or telling. The model call stays outside that lock. A refresh still replaces the board when it commits. It re-reads first, keeps history and any comment or telling the new board still carries, and refuses to write when another refresh has already committed. If the lock cannot be acquired, the command exits non-zero and an HTTP refresh returns an error without rewriting the state file. Run one serve per workspace. A second `serve` on that state file exits before it listens. Do not run two containers on one workspace.

During one refresh, each successfully appended rumor uses a distinct rumor-target persona set—the unordered persona IDs in `roles.targets`, including the empty set when there are zero targets. The refresh loop resamples role picks up to a small retry budget when a set would repeat; only accepted tidbits reserve a set, and deduplication is scoped to that batch only (not prior days or generated history).

On the default refresh path (no injected role picker), the loop pursues every roster persona appearing as teller or hearer on at least one accepted rumor and as a rumor-target on at least one accepted rumor. Empty target sets do not count toward target coverage. It stops as soon as that coverage is complete or the requested count is reached; a low count can therefore successfully return a roster-incomplete board.

```bash
node src/cli.js refresh 1 --base-dir .
```

For a deployed instance, call the HTTP endpoint with `POST`. The request body is optional:

```bash
curl -i -X POST http://127.0.0.1:8080/gossip/refresh \
  -H "Authorization: Bearer $GOSSIP_REFRESH_SECRET"
```

The same endpoint is available at `/refresh`:

```bash
curl -i -X POST http://127.0.0.1:8080/refresh \
  -H "Authorization: Bearer $GOSSIP_REFRESH_SECRET"
```

The response is JSON containing the generated tidbits and generation status. `refreshed` equals `tidbits.length` and neither exceeds the requested count. Refresh requires the configured Subwave credentials and LLM provider settings.

## Docker

The image keeps application code in `/app` and runtime configuration/state in `/workspace`:

```bash
docker build -t subwave-gossip-companion .
docker run --rm -p 8787:8080 \
  --env-file /path/to/gossip.env \
  -v /path/to/gossip-workspace:/workspace \
  subwave-gossip-companion
```

This publishes host port `8787` to the image's container port `8080`; use `http://127.0.0.1:8787` for feed and refresh requests. The container listens on `8080`. Run one serve per workspace. Do not run two containers on one workspace; a second container sharing it cannot serve beside the first.

`GOSSIP_SHUTDOWN_DEADLINE_MS` defaults to `5000`. The orchestrator stop grace has to be strictly longer than that deadline plus the five-second exclusive state-lock wait. Docker's default grace of 10 seconds is not long enough for the default deadline: set it to at least 15 seconds (`docker run --stop-timeout`, `docker stop --time`, Compose `stop_grace_period`). Unraid uses Docker's stop grace and needs the same setting.

Put `prompt.md` and `gossip-types.json` in the mounted workspace, or set `GOSSIP_TYPES_PATH` to another path under the mount. The entrypoint refreshes `prompt.md.default` on every start and seeds `prompt.md` when it is missing or empty; the Node process applies the same rules for non-Docker runs. It sets `GOSSIP_BASE_DIR=/workspace` and starts the server with that base directory. Persist `/workspace` to retain gossip state, operator prompt/types files, the operational log, and the LLM call log. What to copy, how to recover a corrupt state file, and how image tags relate to that directory are in [docs/backup.md](docs/backup.md).

## GitHub Container Registry

The GitHub Actions workflow publishes `ghcr.io/<owner>/subwave-gossip-companion` on pushes to `main` and on version tags. Pull requests run the tests and build the image without publishing.

## Scheduled commands

The image entrypoint only runs `serve` (`node src/cli.js serve --base-dir /workspace`). It does not install cron. Scheduling stays on the host, Unraid User Scripts, or another external runner.

Run one serve per workspace. A second `serve`, or a second container mounting the same workspace, is refused and does not replace the gossip state file. Do not run two containers on one workspace. The host crontab and the `docker exec` commands below stay the writers. They commit while that one `serve` is running and are serialized with it on the state file.

`refresh` replaces the active gossip slate. `seed` appends tidbits and leaves existing ones in place. The daily job in `crontab` is `refresh`. Use `seed` only when you intentionally want to append. `ingest-spoken` pulls new spoken events into state; it does not generate the daily slate.

Application code in the image is `/app`. Persistent state is `/workspace`. Every example passes `--base-dir /workspace`.

Bare metal (checkout or image filesystem mounted at `/app`, workspace at `/workspace`):

```bash
cd /app && node src/cli.js refresh --base-dir /workspace
cd /app && node src/cli.js seed --base-dir /workspace
cd /app && node src/cli.js ingest-spoken --base-dir /workspace
```

Docker or Unraid, from the host, against a running container named `subwave-gossip-companion`:

```bash
docker exec subwave-gossip-companion node src/cli.js refresh --base-dir /workspace
docker exec subwave-gossip-companion node src/cli.js seed --base-dir /workspace
docker exec subwave-gossip-companion node src/cli.js ingest-spoken --base-dir /workspace
```

The included `crontab` is a host crontab for the same `/app` and `/workspace` paths: daily `refresh` at 04:00 and `ingest-spoken` every five minutes. It is not copied into the image.

## Unraid

Install the container template directly into the Community Applications templates directory:

```bash
curl -fsSL https://raw.githubusercontent.com/doguitar/subwave-gossip-companion/main/unraid/my-subwave-gossip-companion.xml \
  -o /boot/config/plugins/dockerMan/templates-user/my-subwave-gossip-companion.xml
```

Then open **Docker → Add Container**, choose the `subwave-gossip-companion` template, enter the Subwave and LLM credentials plus a long unique refresh operator secret, and apply. Keep the refresh secret private; the template masks it. Set conservative refresh admission values for an internet-reachable deployment. The template maps host port `8080` to container port `8080`; persistent files use `/mnt/user/appdata/subwave-gossip-companion`. Unraid uses Docker's stop grace. `GOSSIP_SHUTDOWN_DEADLINE_MS` defaults to `5000`, and that grace has to be strictly longer than the deadline plus the five-second exclusive state-lock wait. Docker's default grace of 10 seconds is not long enough for the default deadline: set it to at least 15 seconds (`docker run --stop-timeout`, `docker stop --time`, Compose `stop_grace_period`).