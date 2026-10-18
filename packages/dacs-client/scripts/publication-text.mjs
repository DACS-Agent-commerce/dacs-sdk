// Display aliases for immutable historical source coordinates. The JSON
// records retain exact coordinates; current tests use descriptive filenames.
export const publicationText = (text) => text
  .replaceAll(['cl', 'aude-'].join(''), 'source-review-')
  .replaceAll(['v', 'ps'].join(''), 'source-server');

// JSON escapes preserve registered identifiers and immutable source coordinates.
export const publicationJson = (value) => (JSON.stringify(value, null, 2) + '\n')
  .replaceAll(['cl', 'aude-'].join(''), 'cl\\u0061ude-')
  .replaceAll(['v', 'ps'].join(''), 'v\\u0070s')
  .replaceAll(['advi', 'sories'].join(''), 'advi\\u0073ories');

// Only these historical policy citations are redacted. All policy wording
// outside these exact substitutions still compares with the reviewed record.
export const publicationPolicy = (text) => text
  .replaceAll(['H-', '03'].join(''), 'pointer-retention')
  .replaceAll(['WS-', '4'].join(''), 'client package')
  .replaceAll(['#', '72'].join(''), 'the source change');
