/** Save / open / share experiments. */
import {
  decodeExperiment,
  encodeExperiment,
  parseExperiment,
  type Experiment,
  type ParseResult,
} from '../schema/experiment';

export function downloadText(filename: string, text: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'experiment'
  );
}

export function saveExperiment(exp: Experiment): void {
  downloadText(`${slug(exp.name)}.wavelab.json`, JSON.stringify(exp, null, 2));
}

export async function readExperimentFile(file: File): Promise<ParseResult> {
  if (file.size > 2_000_000) return { ok: false, errors: ['File is larger than 2 MB.'] };
  try {
    return parseExperiment(JSON.parse(await file.text()));
  } catch (err) {
    return { ok: false, errors: [`Not a valid JSON file: ${(err as Error).message}`] };
  }
}

const HASH_KEY = 'exp=';

export function shareUrl(exp: Experiment): string {
  const url = new URL(window.location.href);
  url.hash = HASH_KEY + encodeExperiment(exp);
  return url.toString();
}

/** Experiment encoded in the page URL fragment, if any. */
export function experimentFromLocation(): ParseResult | null {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash.startsWith(HASH_KEY)) return null;
  return decodeExperiment(hash.slice(HASH_KEY.length));
}
