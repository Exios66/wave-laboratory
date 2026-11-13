/**
 * The Content-Security-Policy the production build ships. GitHub Pages cannot set response
 * headers, so it goes into index.html as a <meta> tag (vite.config.ts; the dev server needs
 * inline scripts for hot reload, so it is build-only).
 *
 * - 'wasm-unsafe-eval': the meshopt decoder compiles its WebAssembly (scenery models).
 * - style 'unsafe-inline': React `style` props and the chart library's inline styles.
 * - img data:/blob:: the inline favicon; textures the glTF loader unpacks into blob URLs.
 * - connect blob:: the glTF loader fetches those blob URLs to decode them as ImageBitmaps.
 * - worker blob:: kept for module workers some browsers start from a blob URL.
 */
export const CSP_DIRECTIVES: Readonly<Record<string, readonly string[]>> = {
  'default-src': ["'self'"],
  'script-src': ["'self'", "'wasm-unsafe-eval'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'blob:'],
  'font-src': ["'self'"],
  'connect-src': ["'self'", 'blob:'],
  'worker-src': ["'self'", 'blob:'],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
};

export function cspContent(
  d: Readonly<Record<string, readonly string[]>> = CSP_DIRECTIVES,
): string {
  return Object.entries(d)
    .map(([name, sources]) => `${name} ${sources.join(' ')}`)
    .join('; ');
}

export function cspMetaTag(): string {
  return `<meta http-equiv="Content-Security-Policy" content="${cspContent()}" />`;
}
