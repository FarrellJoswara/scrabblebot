// Fast rack-to-words engine.
//
// Each word is stored under its sorted letters ("key"). All anagrams share
// one key and one reward. A trie over the keys lists every word that a rack
// can spell. The walk visits only rack sub-multisets that start some key, so
// it does not scan the full lexicon.

import { loadLexicon } from "./sim/dictionary.js";
import { wordReward } from "./sim/rules.js";

interface Engine {
  child: Int32Array; // first child of each node, or -1
  sib: Int32Array; // next sibling of each node, or -1
  ch: Uint8Array; // letter of each node, 0..25
  key: Int32Array; // key id that ends at each node, or -1
  letters: Uint8Array[]; // per key: sorted letter indices
  reward: Int32Array; // per key
  word: string[]; // per key: one dictionary word (lex-first)
}

let engine: Engine | undefined;

export function loadEngine(): Engine {
  if (engine) return engine;
  const child: number[] = [-1];
  const sib: number[] = [-1];
  const ch: number[] = [0];
  const key: number[] = [-1];
  const letters: Uint8Array[] = [];
  const reward: number[] = [];
  const word: string[] = [];

  // byLength is lex-sorted inside each length, so the first word per key
  // is the lex-first anagram.
  for (const w of loadLexicon().byLength) {
    const ls = Uint8Array.from([...w].map((c) => c.charCodeAt(0) - 65)).sort();
    let node = 0;
    for (const l of ls) {
      let c = child[node]!;
      let prev = -1;
      while (c !== -1 && ch[c]! < l) {
        prev = c;
        c = sib[c]!;
      }
      if (c === -1 || ch[c] !== l) {
        const n = ch.length;
        child.push(-1);
        sib.push(c);
        ch.push(l);
        key.push(-1);
        if (prev === -1) child[node] = n;
        else sib[prev] = n;
        c = n;
      }
      node = c;
    }
    if (key[node] === -1) {
      key[node] = letters.length;
      letters.push(ls);
      reward.push(wordReward(w));
      word.push(w);
    }
  }
  engine = {
    child: Int32Array.from(child),
    sib: Int32Array.from(sib),
    ch: Uint8Array.from(ch),
    key: Int32Array.from(key),
    letters,
    reward: Int32Array.from(reward),
    word,
  };
  return engine;
}

// Key ids of all words the rack can spell. `rc` holds 26 letter counts. It
// is changed during the walk and restored before return.
export function wordsIn(rc: number[]): number[] {
  const e = loadEngine();
  const out: number[] = [];
  const walk = (node: number) => {
    for (let c = e.child[node]!; c !== -1; c = e.sib[c]!) {
      const l = e.ch[c]!;
      if (rc[l] === 0) continue;
      rc[l]!--;
      if (e.key[c]! >= 0) out.push(e.key[c]!);
      walk(c);
      rc[l]!++;
    }
  };
  walk(0);
  return out;
}

export function keyReward(k: number): number {
  return loadEngine().reward[k]!;
}

export function keyWord(k: number): string {
  return loadEngine().word[k]!;
}

export function fits(rc: number[], k: number): boolean {
  const ls = loadEngine().letters[k]!;
  for (let i = 0; i < ls.length; ) {
    const l = ls[i]!;
    let j = i + 1;
    while (j < ls.length && ls[j] === l) j++;
    if (rc[l]! < j - i) return false;
    i = j;
  }
  return true;
}

// sign 1 removes the word's letters from rc, sign -1 puts them back.
export function take(rc: number[], k: number, sign = 1) {
  for (const l of loadEngine().letters[k]!) rc[l]! -= sign;
}

function byReward(keys: number[]): number[] {
  const r = loadEngine().reward;
  return keys.sort((a, b) => r[b]! - r[a]!);
}

function greedy(rc: number[], cands: number[], out: number[] | null): number {
  let score = 0;
  for (const k of cands) {
    while (fits(rc, k)) {
      take(rc, k);
      score += keyReward(k);
      out?.push(k);
    }
  }
  return score;
}

// Best set of disjoint words (approximate). Try each of the top `beam`
// words as the first pick, then fill the rest greedily.
export function bestSplit(rc: number[], beam: number): { score: number; keys: number[] } {
  const cands = byReward(wordsIn(rc));
  let best = { score: 0, keys: [] as number[] };
  const n = Math.min(Math.max(beam, 1), cands.length);
  for (let i = 0; i < n; i++) {
    const r = [...rc];
    const keys = [cands[i]!];
    take(r, cands[i]!);
    const score = keyReward(cands[i]!) + greedy(r, cands, keys);
    if (score > best.score) best = { score, keys };
  }
  return best;
}

// Score of bestSplit, memoized by rack. Monte Carlo valuation asks for the
// same racks many times.
const memo = new Map<string, number>();
const MEMO_CAP = 400_000;

export function splitScore(rc: number[], beam: number): number {
  const id = String.fromCharCode(...rc) + beam;
  const hit = memo.get(id);
  if (hit !== undefined) return hit;
  const s = bestSplit(rc, beam).score;
  if (memo.size >= MEMO_CAP) memo.clear();
  memo.set(id, s);
  return s;
}
