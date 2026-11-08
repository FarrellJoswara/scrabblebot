// Babbler strategy. Shared by the live bot and the simulator.
//
// Words: keep letters to make long words (7+ letters pay 3x). Near the end,
// split the full rack into the best set of words.
// Bids: value a letter by how much it adds to the best split of the rack.

import { loadLexicon, rackToCounts } from "./sim/dictionary.js";
import { letterValue, wordReward } from "./sim/rules.js";

export interface BrainParams {
  flushAt: number; // play all letters when fewer tiles than this are left in the bag (min 1)
  playLen: number; // mid-game, play words with this many letters or more
  a: number; // bid = a + b * letterValue + c * gain
  b: number;
  c: number;
  beam: number; // first words tried in bestSplit
}

export const DEFAULT_PARAMS: BrainParams = {
  flushAt: 2,
  playLen: 7,
  a: 4,
  b: 1,
  c: 1,
  beam: 12,
};

export interface BrainInput {
  rack: ReadonlyMap<string, number>;
  letter: string;
  bagRemaining: number;
  isLastAuction: boolean;
  balance: number;
}

export interface Decision {
  words: string[];
  bid: number;
}

interface Cand {
  idx: number;
  reward: number;
}

// Words the counts can spell, highest reward first.
function candidates(rc: number[]): Cand[] {
  const { byLength, masks, counts } = loadLexicon();
  let total = 0;
  let mask = 0;
  for (let i = 0; i < 26; i++) {
    total += rc[i]!;
    if (rc[i]! > 0) mask |= 1 << i;
  }
  const out: Cand[] = [];
  if (total < 2) return out;
  for (let i = 0; i < byLength.length; i++) {
    if ((masks[i]! & ~mask) !== 0) continue;
    const w = byLength[i]!;
    if (w.length > total) continue;
    if (fits(rc, counts, i)) out.push({ idx: i, reward: wordReward(w) });
  }
  out.sort((x, y) => y.reward - x.reward);
  return out;
}

function fits(rc: number[], counts: Uint8Array, i: number): boolean {
  const base = i * 26;
  for (let s = 0; s < 26; s++) if (counts[base + s]! > rc[s]!) return false;
  return true;
}

function take(rc: number[], counts: Uint8Array, i: number) {
  const base = i * 26;
  for (let s = 0; s < 26; s++) rc[s]! -= counts[base + s]!;
}

// Take the highest-reward word that fits, again and again.
function greedy(rc: number[], cands: Cand[]): { score: number; idx: number[] } {
  const { counts } = loadLexicon();
  let score = 0;
  const idx: number[] = [];
  for (const c of cands) {
    while (fits(rc, counts, c.idx)) {
      take(rc, counts, c.idx);
      score += c.reward;
      idx.push(c.idx);
    }
  }
  return { score, idx };
}

// Best set of disjoint words from the counts: try each of the first `beam`
// words first, then fill greedily.
export function bestSplit(
  rc: number[],
  beam: number,
): { score: number; idx: number[]; words: string[] } {
  const { byLength, counts } = loadLexicon();
  const cands = candidates(rc);
  let best = greedy([...rc], cands);
  for (let k = 1; k < Math.min(beam, cands.length); k++) {
    const r = [...rc];
    take(r, counts, cands[k]!.idx);
    const rest = greedy(r, cands);
    const score = cands[k]!.reward + rest.score;
    if (score > best.score) best = { score, idx: [cands[k]!.idx, ...rest.idx] };
  }
  return { ...best, words: best.idx.map((i) => byLength[i]!) };
}

export function decide(input: BrainInput, p: BrainParams = DEFAULT_PARAMS): Decision {
  const { byLength, counts } = loadLexicon();
  const rc = rackToCounts(input.rack);
  const words: string[] = [];

  if (input.bagRemaining < p.flushAt) {
    // Endgame: play the best split of the full rack.
    for (const i of bestSplit(rc, p.beam).idx) {
      words.push(byLength[i]!);
      take(rc, counts, i);
    }
  } else {
    // Mid-game: play long words only.
    for (;;) {
      const c = candidates(rc).find((x) => byLength[x.idx]!.length >= p.playLen);
      if (!c) break;
      words.push(byLength[c.idx]!);
      take(rc, counts, c.idx);
    }
  }

  // The last letter can never be played.
  if (input.isLastAuction) return { words, bid: 0 };

  let balance = input.balance;
  for (const w of words) balance += wordReward(w);

  const before = bestSplit(rc, p.beam).score;
  const withL = [...rc];
  withL[input.letter.charCodeAt(0) - 65]!++;
  const gain = bestSplit(withL, p.beam).score - before;

  const value = p.a + p.b * letterValue(input.letter) + p.c * gain;
  const bid = Math.max(0, Math.min(Math.floor(value), balance));
  return { words, bid };
}
