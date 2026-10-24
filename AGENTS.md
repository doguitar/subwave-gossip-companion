# Agent guide

Read the section that matches the change. Do not copy `docs/reference.md` into this file. Operator keys, routes, and commands live there.

## Where to edit

| Change | Read and edit | Prove it with |
|---|---|---|
| Generation, prompts, provider calls, review | `src/llm.js`, `src/seed.js`, `src/review.js`, `prompt.md` | `test/llm.test.js`, `test/seed.test.js`, `test/review.test.js` |
| Acceptance of a rumor | `src/validate.js`, called from `src/seed.js` | `test/validate.test.js`, `test/seed.test.js` |
| Stored tidbits, comments, tellings, locks | `src/store.js` | `test/store.test.js` |
| RSS selection and item shape | `src/rss.js`, `src/server.js` | `test/rss.test.js` |
| Station skill text | `skills/station-gossip/SKILL.md`, `skills/station-gossip-cohosted/SKILL.md`, `src/skill.js` | `test/skill.test.js` |
| Config and CLI flags | `src/config.js`, `src/cli.js`, `.env.example`, `config.yaml.example` | `test/cli.test.js` |
| HTTP routes and probes | `src/server.js` | `test/probes.test.js`, `test/refresh.test.js` |
| Deployment and operator docs | `Dockerfile`, `docker-entrypoint.sh`, `crontab`, `README.md`, `docs/reference.md` | `test/deployment-docs.test.js` |
| Spoken ingest and on-air follow-up | `src/ingest.js`, `src/spoken.js`, `src/followup.js` | `test/ingest.test.js`, `test/followup.test.js` |
| Logs | `src/callLog.js`, `src/log.js` | `test/call-log.test.js`, `test/llm.test.js` |

A behavior change updates the test that locks the contract and, when an operator can see it, `docs/reference.md` or `README.md`.

## Invariants

- One `serve` per state file. A second serve exits before it listens.
- `seed` appends tidbits. `refresh` replaces the board and keeps history the new board still carries.
- `POST /refresh` and `POST /gossip/refresh` require `Authorization: Bearer` equal to `GOSSIP_REFRESH_SECRET`.
- `GET /gossip.rss` requires `show`. Items do not include persona ids.
- `GET /` and `GET /gossip.rss` are unauthenticated.
- `GOSSIP_LLM_LOG_CONTENT=metadata` drops prompt and response bodies.

## Done

Run `npm test`. Then run the test file named for the path you changed, for example `node --test test/rss.test.js`.

Do not commit `.env`, `config.yaml`, `logs/`, `data/*.json`, or a station-private `prompt.md`. The packaged `prompt.md` stays the product prompt.
