import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readArtifact(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8');
}

test('deployment documentation keeps the Docker, image, and Unraid port contract aligned', async () => {
  const [dockerfile, readme, unraidTemplate, crontab] = await Promise.all([
    readArtifact('Dockerfile'),
    readArtifact('README.md'),
    readArtifact('unraid/my-subwave-gossip-companion.xml'),
    readArtifact('crontab'),
  ]);

  assert.match(dockerfile, /GOSSIP_PORT=8080/);
  assert.match(dockerfile, /^EXPOSE 8080$/m);
  assert.match(
    dockerfile,
    /HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \\[\s\S]*127\.0\.0\.1[\s\S]*GOSSIP_PORT[\s\S]*\/health/,
  );
  assert.doesNotMatch(dockerfile, /\/ready/);

  assert.match(readme, /docker run --rm -p 8787:8080 \\/);
  assert.match(
    readme,
    /This publishes host port `8787` to the image's container port `8080`;/,
  );
  assert.match(readme, /`GET \/health` is the liveness probe/);
  assert.match(readme, /`GET \/ready` is the readiness probe/);
  assert.match(readme, /image healthcheck calls liveness only/);
  assert.match(
    readme,
    /The template maps host port `8080` to container port `8080`;/,
  );
  assert.match(
    readme,
    /http:\/\/127\.0\.0\.1:8080\/gossip\.rss\?show=Island%20Time&actor=p_79eaff/,
  );
  assert.match(readme, /http:\/\/127\.0\.0\.1:8080\/gossip\/refresh/);
  assert.match(readme, /http:\/\/127\.0\.0\.1:8080\/refresh/);
  assert.match(readme, /GOSSIP_REFRESH_SECRET/);
  assert.match(readme, /Authorization: Bearer/);
  assert.doesNotMatch(readme, /http:\/\/127\.0\.0\.1:8095/);
  assert.match(readme, /The image entrypoint only runs `serve`/);
  assert.match(readme, /one serve per workspace/);
  assert.match(readme, /Do not run two containers on one workspace/);
  assert.match(readme, /serialized with/);
  assert.doesNotMatch(readme, /not coordinated/);
  assert.match(dockerfile, /One serve per workspace/);
  assert.match(dockerfile, /CMD \["node", "src\/cli\.js", "serve", "--base-dir", "\/workspace"\]/);
  assert.match(crontab, /serialized with/);
  assert.match(crontab, /Do not start a second serve/);
  assert.match(readme, /`refresh` replaces the active gossip slate/);
  assert.match(readme, /`seed` appends tidbits/);
  assert.match(readme, /node src\/cli\.js refresh --base-dir \/workspace/);
  assert.match(readme, /node src\/cli\.js seed --base-dir \/workspace/);
  assert.match(readme, /node src\/cli\.js ingest-spoken --base-dir \/workspace/);
  assert.match(crontab, /node src\/cli\.js refresh --base-dir \/workspace/);
  assert.match(crontab, /node src\/cli\.js ingest-spoken --base-dir \/workspace/);
  assert.doesNotMatch(crontab, /\/opt\/station-gossip-companion/);
  assert.doesNotMatch(crontab, /^[^#]*\bseed\b/m);

  assert.match(
    unraidTemplate,
    /<Config Name="HTTP port" Target="8080" Default="8080"[^>]*>8080<\/Config>/,
  );
  assert.match(unraidTemplate, /<Repository>ghcr\.io\/doguitar\/subwave-gossip-companion:v1\.0\.0<\/Repository>/);
  assert.match(unraidTemplate, /floating tag latest/);
  assert.match(unraidTemplate, /<Icon>https:\/\/github\.com\/doguitar\.png<\/Icon>/);
  assert.doesNotMatch(unraidTemplate, /icon\.png/);
  assert.match(unraidTemplate, /192\.168\.1\.20:8080/);
  assert.match(unraidTemplate, /subwave-gossip-companion:8080/);
  assert.doesNotMatch(unraidTemplate, /GOSSIP_FEED_BASE_URL" Target="GOSSIP_FEED_BASE_URL" Default="http:\/\/127\.0\.0\.1:8080"/);
  for (const [name, value] of [
    ['GOSSIP_REVIEW_ROUNDS', '0'],
    ['GOSSIP_SOUL_SUMMARY', '1'],
    ['GOSSIP_TTS_TIMEOUT_MS', '300000'],
    ['GOSSIP_TTS_POLL_MS', '3000'],
    ['GOSSIP_LLM_LOG_CONTENT', 'metadata'],
    ['GOSSIP_STATE_PATH', 'data/gossip-state.json'],
    ['GOSSIP_TYPES_PATH', 'gossip-types.json'],
    ['GOSSIP_REFRESH_SECRET', ''],
    ['GOSSIP_SHUTDOWN_DEADLINE_MS', '5000'],
  ]) {
    assert.match(unraidTemplate, new RegExp(`Name="${name}"[^>]*Default="${value.replaceAll('/', '\\/')}"`));
  }
  assert.match(
    unraidTemplate,
    /<Config Name="GOSSIP_REFRESH_SECRET" Target="GOSSIP_REFRESH_SECRET" Default=""[^>]*Mask="true"/,
  );
});

test('operator docs state the shutdown deadline and orchestrator grace rule', async () => {
  const [readme, example, settings] = await Promise.all([
    readArtifact('README.md'),
    readArtifact('.env.example'),
    readArtifact('config.yaml.example'),
  ]);
  for (const text of [readme, example, settings]) {
    assert.match(text, /GOSSIP_SHUTDOWN_DEADLINE_MS/);
    assert.match(text, /5000/);
    assert.match(text, /strictly longer than (?:the|this|that) deadline plus the five-second exclusive state-lock wait/);
    assert.match(text, /10 seconds/);
    assert.match(text, /at least 15 seconds/);
    assert.match(text, /docker run --stop-timeout/);
    assert.match(text, /docker stop --time/);
    assert.match(text, /stop_grace_period/);
    assert.match(text, /Unraid/);
  }
});

test('operator docs state operational log size and retention', async () => {
  const [readme, example, settings] = await Promise.all([
    readArtifact('README.md'),
    readArtifact('.env.example'),
    readArtifact('config.yaml.example'),
  ]);
  for (const text of [readme, example, settings]) {
    assert.match(text, /GOSSIP_OPERATIONAL_LOG_MAX_BYTES/);
    assert.match(text, /524288/);
    assert.match(text, /512 KiB/);
    assert.match(text, /GOSSIP_OPERATIONAL_LOG_RETENTION_MS/);
    assert.match(text, /604800000/);
    assert.match(text, /seven days/);
    assert.match(text, /logs\/gossip\.log/);
    assert.match(text, /gossip\.<milliseconds>\.log/);
  }
});

test('operator reference covers commands, routes, env, and privacy', async () => {
  const [readme, example, reference] = await Promise.all([
    readArtifact('README.md'),
    readArtifact('.env.example'),
    readArtifact('docs/reference.md'),
  ]);
  assert.match(readme, /docs\/reference\.md/);
  for (const command of ['serve', 'seed', 'refresh', 'generate', 'summarize-souls', 'ingest-spoken']) {
    assert.match(reference, new RegExp(command));
  }
  for (const route of ['GET /', 'GET /health', 'GET /ready', 'POST /refresh', 'POST /gossip/refresh', 'GET /gossip.rss']) {
    assert.match(reference, new RegExp(route.replaceAll('/', '\\/')));
  }
  for (const key of ['SUBWAVE_API_TOKEN', 'GOSSIP_LLM_LOG_CONTENT', 'GOSSIP_TTS_TIMEOUT_MS', 'GOSSIP_TTS_POLL_MS']) {
    assert.match(example, new RegExp(key));
    assert.match(reference, new RegExp(key));
  }
  assert.match(reference, /unauthenticated/);
  assert.match(reference, /full/);
});

test('operator reference describes the Show rumors section on GET /', async () => {
  const reference = await readArtifact('docs/reference.md');
  assert.match(reference, /\| `GET \/` \|[\s\S]*Show rumors/);
  assert.match(reference, /same unauthenticated fiction as the no-actor show feed/);
});

test('contributor guidance routes changes and separates issue kinds', async () => {
  const [agents, contributing, checklist, companion, subwave, operator, readme] = await Promise.all([
    readArtifact('AGENTS.md'),
    readArtifact('CONTRIBUTING.md'),
    readArtifact('.github/PULL_REQUEST_TEMPLATE.md'),
    readArtifact('.github/ISSUE_TEMPLATE/companion-defect.md'),
    readArtifact('.github/ISSUE_TEMPLATE/subwave-defect.md'),
    readArtifact('.github/ISSUE_TEMPLATE/operator-configuration.md'),
    readArtifact('README.md'),
  ]);
  assert.match(readme, /AGENTS\.md/);
  assert.match(agents, /src\/seed\.js/);
  assert.match(agents, /src\/store\.js/);
  assert.match(agents, /src\/rss\.js/);
  assert.match(agents, /skills\/station-gossip\/SKILL\.md/);
  assert.match(agents, /src\/config\.js/);
  assert.match(agents, /Dockerfile/);
  assert.match(agents, /npm test/);
  assert.match(agents, /docs\/reference\.md/);
  assert.match(agents, /Do not commit `\.env`/);
  assert.match(contributing, /companion-defect/);
  assert.match(contributing, /Subwave-defect/);
  assert.match(contributing, /operator-configuration/);
  assert.match(checklist, /npm test/);
  assert.match(checklist, /secrets/);
  assert.match(companion, /Companion defect/);
  assert.match(subwave, /Subwave defect/);
  assert.match(operator, /Operator configuration/);
});

test('backup guidance names workspace files, corrupt restore, and image tags', async () => {
  const [readme, backup] = await Promise.all([
    readArtifact('README.md'),
    readArtifact('docs/backup.md'),
  ]);
  assert.match(readme, /docs\/backup\.md/);
  for (const phrase of [
    'gossip-state.json',
    'prompt.md.default',
    'review.md.default',
    'gossip-types.json',
    'logs/',
    'does not rewrite',
    'Do not delete the file',
    'ghcr.io',
    'latest',
  ]) {
    assert.match(backup, new RegExp(phrase.replaceAll(/[./]/g, '\\$&')));
  }
});

test('changelog is the operator release note and is linked from upgrade docs', async () => {
  const [changelog, readme, backup, checklist, template] = await Promise.all([
    readArtifact('CHANGELOG.md'),
    readArtifact('README.md'),
    readArtifact('docs/backup.md'),
    readArtifact('.github/PULL_REQUEST_TEMPLATE.md'),
    readArtifact('unraid/my-subwave-gossip-companion.xml'),
  ]);
  assert.match(changelog, /## v1\.0\.0/);
  assert.match(changelog, /workspace/i);
  assert.match(changelog, /vX\.Y\.Z/);
  assert.match(readme, /CHANGELOG\.md/);
  assert.match(backup, /CHANGELOG\.md/);
  assert.match(template, /CHANGELOG\.md/);
  assert.match(checklist, /CHANGELOG\.md/);
});

test('refresh count docs describe accepted tidbits and omit the attempt budget', async () => {
  const [readme, reference] = await Promise.all([
    readArtifact('README.md'),
    readArtifact('docs/reference.md'),
  ]);
  assert.match(
    readme,
    /`GOSSIP_REFRESH_COUNT` \(default `1`, range `1`–`10`\) is the default maximum number of accepted tidbits for one refresh\./,
  );
  assert.doesNotMatch(readme, /attempt budget/i);
  assert.doesNotMatch(readme, /count \* 3/);
  assert.doesNotMatch(reference, /attempt budget/i);
  assert.doesNotMatch(reference, /count \* 3/);
});

test('operator README documents corrupt state refusal and manual restore', async () => {
  const readme = await readArtifact('README.md');
  assert.match(readme, /exits non-zero/);
  assert.match(readme, /data\/gossip-state\.json/);
  assert.match(readme, /under the base directory/);
  assert.match(readme, /GOSSIP_STATE_PATH/);
  assert.match(readme, /does not rewrite/);
  assert.match(readme, /replace the file with a backup/);
  assert.match(readme, /external editor/);
  assert.match(readme, /Do not delete the file/);
  assert.match(readme, /empty board/);
});

test('operator instructions describe config.yaml and ignore the generated file', async () => {
  const [readme, reference, example, ignore, agents] = await Promise.all([
    readArtifact('README.md'),
    readArtifact('docs/reference.md'),
    readArtifact('config.yaml.example'),
    readArtifact('.gitignore'),
    readArtifact('AGENTS.md'),
  ]);
  assert.match(readme, /config\.yaml/);
  assert.match(readme, /config\.yaml\.example/);
  assert.match(readme, /os\.environ\//);
  assert.match(readme, /Missing config options/);
  assert.match(readme, /--base` is set|--base` nor `--base`/);
  assert.match(reference, /config\.yaml/);
  assert.match(reference, /config\.yaml\.example/);
  for (const key of ['SUBWAVE_API_TOKEN', 'GOSSIP_REFRESH_SECRET', 'PROVIDER_KEY']) {
    assert.match(example, new RegExp(`${key}: os\\.environ\\/${key}`));
  }
  assert.doesNotMatch(example, /^SUBWAVE_API_(?:USER|PASSWORD):/m);
  assert.match(ignore, /^config\.yaml$/m);
  assert.doesNotMatch(ignore, /config\.yaml\.example/);
  assert.match(agents, /Do not commit `\.env`/);
  assert.match(agents, /`config\.yaml`/);
});

test('operator README documents YAML settings and the example keeps secrets as env references', async () => {
  const [readme, example] = await Promise.all([
    readArtifact('README.md'),
    readArtifact('config.yaml.example'),
  ]);
  assert.match(readme, /config\.yaml/);
  assert.match(readme, /os\.environ\/NAME/);
  assert.match(readme, /Missing config options/);
  assert.match(readme, /--base-dir` wins/);
  assert.match(readme, /A missing file is ignored/);
  assert.match(readme, /any other read error names the path/);
  assert.match(readme, /wins over a YAML literal/);
  assert.match(readme, /overrides a value that came only from `\.env`/);
  assert.doesNotMatch(example, /^SUBWAVE_API_(?:USER|PASSWORD):/m);
  assert.match(example, /^SUBWAVE_API_TOKEN: os\.environ\/SUBWAVE_API_TOKEN$/m);
  assert.match(example, /^PROVIDER_KEY: os\.environ\/PROVIDER_KEY$/m);
  assert.match(example, /^GOSSIP_REFRESH_SECRET: os\.environ\/GOSSIP_REFRESH_SECRET$/m);
  assert.match(example, /^GOSSIP_PORT: "8080"$/m);
  assert.match(example, /^GOSSIP_REVIEW_ROUNDS: "0"$/m);
  assert.match(example, /^PROVIDER_THINKING: ""$/m);
  assert.doesNotMatch(example, /:\s*(?:secret|password|changeme)\b/i);
});
