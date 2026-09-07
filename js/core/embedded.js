/*
 * ZoeWeb — embedded asset store for the single-file build.
 * The build script inlines all vehicle CSVs as gzipped JSON in
 * window.__ZOEWEB_ASSETS__ (base64). When present, the database loader reads
 * from here instead of fetch(), which makes the app work from file://.
 */

let promise = null;

export function embeddedAssets() {
  if (typeof window === 'undefined' || !window.__ZOEWEB_ASSETS__) return null;
  promise ??= (async () => {
    const bytes = Uint8Array.from(atob(window.__ZOEWEB_ASSETS__), c => c.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  })();
  return promise;
}
