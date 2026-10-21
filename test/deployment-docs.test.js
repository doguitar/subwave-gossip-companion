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
  const [dockerfile, readme, unraidTemplate] = await Promise.all([
    readArtifact('Dockerfile'),
    readArtifact('README.md'),
    readArtifact('unraid/my-subwave-gossip-companion.xml'),
  ]);

  assert.match(dockerfile, /GOSSIP_PORT=8080/);
  assert.match(dockerfile, /^EXPOSE 8080$/m);

  assert.match(readme, /docker run --rm -p 8787:8080 \\/);
  assert.match(
    readme,
    /This publishes host port `8787` to the image's container port `8080`;/,
  );
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
  assert.doesNotMatch(readme, /http:\/\/127\.0\.0\.1:8095/);

  assert.match(
    unraidTemplate,
    /<Config Name="HTTP port" Target="8080" Default="8080"[^>]*>8080<\/Config>/,
  );
  assert.match(
    unraidTemplate,
    /<Config Name="GOSSIP_FEED_BASE_URL" Target="GOSSIP_FEED_BASE_URL" Default="http:\/\/127\.0\.0\.1:8080"[^>]*>http:\/\/127\.0\.0\.1:8080<\/Config>/,
  );
});
