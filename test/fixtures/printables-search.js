/**
 * A trimmed copy of what printables.com/search/models returns: a SvelteKit
 * page with several inlined GraphQL responses, only one of which is the model
 * list. Field names and nesting match the real payload.
 */

const model = (id, name, overrides = {}) => ({
  id,
  name,
  slug: name.toLowerCase().replaceAll(' ', '-'),
  ratingAvg: '4.5',
  likesCount: 120,
  downloadCount: 3400,
  datePublished: '2024-02-01T10:00:00+00:00',
  firstPublish: '2023-11-05T09:00:00+00:00',
  image: { filePath: `media/prints/${id}/images/abc/photo.jpg`, __typename: 'PrintImageType' },
  nsfw: false,
  user: { handle: 'maker', publicUsername: 'A Maker', __typename: 'UserType' },
  __typename: 'PrintType',
  ...overrides,
});

const blob = (payload) =>
  `<script type="application/json" data-sveltekit-fetched data-url="https://api.printables.com/graphql/" data-hash="x">${JSON.stringify(
    { status: 200, statusText: '', headers: {}, body: JSON.stringify(payload) },
  )}</script>`;

export const models = [
  model('3161', 'Voronoi Lamp'),
  model('4200', 'Cable Clip', { nsfw: true }),
  model('9001', 'Bracket', { image: null, user: { handle: '', publicUsername: '' } }),
];

export const html = [
  '<!doctype html><html><body>',
  // Not a model list: must be ignored.
  blob({ data: { result: { categories: [{ id: '1' }], totalCount: 4, __typename: 'X' } } }),
  // A shorter model list, as the page carries for related sections.
  blob({ data: { result: { items: [model('55', 'Side Result')], totalCount: 1, __typename: 'PrintList' } } }),
  // The real search result list.
  blob({ data: { result: { items: models, totalCount: 3709, __typename: 'PrintList' } } }),
  '</body></html>',
].join('\n');
