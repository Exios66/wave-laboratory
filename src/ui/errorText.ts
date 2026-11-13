/**
 * Readable text for errors shown to people, and recognition of the one error they can fix
 * themselves: a lazily loaded code chunk that no longer exists because a newer version was
 * deployed while their page was open.
 */

/** Messages Chrome/Edge, Safari and Firefox give when a dynamic `import()` cannot load. */
const CHUNK_LOAD_MESSAGES = [
  'failed to fetch dynamically imported module',
  'importing a module script failed',
  'error loading dynamically imported module',
];

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** True when `err` (an Error or its message) is a failed lazy-chunk load. */
export function isChunkLoadError(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  const message = messageOf(err).toLowerCase();
  return CHUNK_LOAD_MESSAGES.some((m) => message.includes(m));
}

export function errorText(err: unknown): string {
  if (isChunkLoadError(err)) {
    return 'A newer version of Wave Laboratory was published. Reload to continue.';
  }
  return messageOf(err);
}
