/**
 * A trimmed copy of what api.printables.com/graphql/ returns for a search.
 * Field names and nesting match the real payload, including the aliased
 * `result` the query asks for.
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
  nsfw: false,
  price: null,
  premium: false,
  image: { filePath: `media/prints/${id}/images/abc/photo.jpg` },
  user: { handle: 'maker', publicUsername: 'A Maker' },
  ...overrides,
});

export const models = [
  model('3161', 'Voronoi Lamp'),
  model('4200', 'Cable Clip', { nsfw: true }),
  model('9001', 'Bracket', { image: null, user: { handle: '', publicUsername: '' } }),
  model('9002', 'Paid Thing', { premium: true }),
];

export const response = {
  data: { result: { totalCount: 3709, items: models } },
};

export const emptyResponse = {
  data: { result: { totalCount: 0, items: [] } },
};

/** What the API answers when a field the adapter asks for no longer exists. */
export const errorResponse = {
  errors: [{ message: "Cannot query field 'club' on type 'PrintType'." }],
};
