import assert from 'node:assert/strict';
import test from 'node:test';

import { buildImage, extractModels } from '../server/sources/printables.js';
import { html, models } from './fixtures/printables-search.js';

test('extractModels picks the model list out of the inlined GraphQL payloads', () => {
  const found = extractModels(html);

  assert.ok(found, 'the search page should yield a result set');
  assert.equal(found.totalCount, 3709);
  assert.equal(found.items.length, models.length);
  assert.equal(found.items[0].name, 'Voronoi Lamp');
});

test('extractModels returns nothing when the page carries no model list', () => {
  assert.equal(extractModels('<html><body>no results</body></html>'), null);
});

test('extractModels reads an empty hit list as zero results, not as a broken page', () => {
  const empty =
    '<script type="application/json" data-sveltekit-fetched data-hash="x">' +
    JSON.stringify({
      status: 200,
      body: JSON.stringify({ data: { result: { items: [], totalCount: 0 } } }),
    }) +
    '</script>';

  const found = extractModels(empty);
  assert.deepEqual(found, { items: [], totalCount: 0 });
});

test('extractModels survives a malformed payload instead of throwing', () => {
  const broken =
    '<script type="application/json" data-sveltekit-fetched data-hash="x">{not json}</script>';
  assert.equal(extractModels(broken + html).items.length, models.length);
});

test('buildImage points at the webp derivative and keeps the original extension', () => {
  const image = buildImage('media/prints/3161/images/abc/benchy.png');

  assert.equal(
    image.thumb,
    'https://media.printables.com/media/prints/3161/images/abc/thumbs/inside/640x480/png/benchy.webp',
  );
  assert.ok(image.full.includes('/1280x960/png/'));
});

test('buildImage tolerates a missing or extensionless path', () => {
  assert.equal(buildImage(null), null);
  assert.equal(
    buildImage('media/prints/3161/images/abc/benchy').thumb,
    'https://media.printables.com/media/prints/3161/images/abc/benchy',
  );
});
