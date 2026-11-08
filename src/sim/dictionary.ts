// Shared wordlist with fast rack lookups.

import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const A = 65;

export interface Lexicon {
  words: Set<string>;
  // Sorted by length desc, then lex asc (server order).
  byLength: string[];
  // Per word in `byLength`: bit i set if letter i is in the word.
  masks: Uint32Array;
  // Per word in `byLength`: 26 letter counts.
  counts: Uint8Array;
}

let cached: Lexicon | undefined;

export function loadLexicon(): Lexicon {
  if (cached) return cached;
  const file = fileURLToPath(
    new URL("../../spacetimedb/wordlist.txt", import.meta.url),
  );
  const lex = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim().toUpperCase())
    .filter((l) => l.length >= 2 && /^[A-Z]+$/.test(l));
  const byLength = [...new Set(lex)].sort(
    (a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0),
  );
  const masks = new Uint32Array(byLength.length);
  const counts = new Uint8Array(byLength.length * 26);
  byLength.forEach((w, i) => {
    let m = 0;
    for (let k = 0; k < w.length; k++) {
      const s = w.charCodeAt(k) - A;
      m |= 1 << s;
      counts[i * 26 + s]!++;
    }
    masks[i] = m >>> 0;
  });
  cached = { words: new Set(byLength), byLength, masks, counts };
  return cached;
}

export function isValidWord(word: string): boolean {
  return loadLexicon().words.has(word);
}

export function rackToCounts(rack: ReadonlyMap<string, number>): number[] {
  const c = new Array<number>(26).fill(0);
  for (const [l, n] of rack) {
    const s = l.charCodeAt(0) - A;
    if (s >= 0 && s < 26) c[s]! += n;
  }
  return c;
}

// Longest word the rack can spell, lex-first on ties. Same result as the
// server's `findBestPlayable`. Returns undefined if no word has `minLen`
// or more letters.
export function findBestPlayable(
  rack: ReadonlyMap<string, number>,
  minLen: number,
): string | undefined {
  const lex = loadLexicon();
  const rc = rackToCounts(rack);
  let total = 0;
  let mask = 0;
  for (let i = 0; i < 26; i++) {
    total += rc[i]!;
    if (rc[i]! > 0) mask |= 1 << i;
  }
  if (total < minLen) return undefined;
  const { byLength, masks, counts } = lex;
  for (let i = 0; i < byLength.length; i++) {
    const len = byLength[i]!.length;
    if (len < minLen) break;
    if (len > total) continue;
    if ((masks[i]! & ~mask) !== 0) continue;
    let ok = true;
    const base = i * 26;
    for (let s = 0; s < 26; s++) {
      if (counts[base + s]! > rc[s]!) {
        ok = false;
        break;
      }
    }
    if (ok) return byLength[i];
  }
  return undefined;
}
