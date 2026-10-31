import { readFile } from 'node:fs/promises';
// Inspect private pure decisions without adding a runtime API or enabling a
// staged factory. Imports still resolve to the real shipped collaborators.
export async function privateModule(url, names, transform = source => source) {
  const source = transform(await readFile(url, 'utf8')).replace(/from (['"])([^'"]+)\1/g, (match, quote, specifier) =>
    `from ${JSON.stringify(specifier.startsWith('.') ? new URL(specifier, url).href : import.meta.resolve(specifier))}`);
  return import(`data:text/javascript;base64,${Buffer.from(source + '\nexport { ' + names.join(', ') + ' };\n//# sourceURL=' + url.href + '?TEST-private').toString('base64')}`);
}
