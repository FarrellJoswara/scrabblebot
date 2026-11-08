// Babbler strategy. Shared by the live bot and the simulator.
//
// Words:
//   Mid-game: play if rack is overflowing OR a word meets the length threshold.
//   The threshold graduates down as the bag empties so we don't hoard tiles.
//   Endgame (bag < flushAt): play the best split of the full rack.
//
// Bids: value a letter by its static value PLUS how much it improves the best
//   possible word-split of our current rack.  Budget is paced so we don't
//   blow all our coins in the first few auctions.

import { loadLexicon, rackToCounts } from "./sim/dictionary.js";
import { letterValue, wordReward } from "./sim/rules.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface BrainParams {
  flushAt: number;    // start full-rack flush when bag has fewer tiles than this
  playLen: number;    // mid-game minimum word length (graduates down near endgame)
  maxRack: number;    // play best word of any length when rack >= this many tiles
  a: number;          // bid = a + b * letterValue + c * gain + adjustments
  b: number;
  c: number;
  vowelWeight: number;// weight for vowel/consonant balance heuristics
  synergyWeight: number; // weight for Q+U, awkward consonant avoidance, S/E versatility
  budgetFrac: number; // fraction of remaining budget we're willing to bid per auction
  beam: number;       // beam width for bestSplit
}

export const DEFAULT_PARAMS: BrainParams = {
  flushAt: 2,
  playLen: 7,
  maxRack: 9,
  a: 3,
  b: 0.8,
  c: 1.2,
  vowelWeight: 1.0,
  synergyWeight: 1.0,
  budgetFrac: 0.25,
  beam: 12,
};

// Load trained params from best-params.json if present, fall back to defaults.
function loadParams(): BrainParams {
  try {
    const paramsPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "best-params.json",
    );
    const raw = JSON.parse(fs.readFileSync(paramsPath, "utf8")) as Partial<BrainParams>;
    return { ...DEFAULT_PARAMS, ...raw };
  } catch {
    return { ...DEFAULT_PARAMS };
  }
}

export const TRAINED_PARAMS: BrainParams = loadParams();

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

// All words the rack can spell, sorted by reward desc.
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

function rackTotal(rc: number[]): number {
  let t = 0;
  for (let i = 0; i < 26; i++) t += rc[i]!;
  return t;
}

// Take the highest-reward word repeatedly, greedy.
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

// Best set of disjoint words: try each of the first `beam` candidates as the
// first pick, fill the rest greedily. O(beam * |cands|).
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

// Minimum word length to play mid-game, graduated by bag size.
function midGameMinLen(bagRemaining: number, p: BrainParams): number {
  if (bagRemaining >= 20) return p.playLen;      // plenty of tiles left: hold for longs
  if (bagRemaining >= 10) return Math.max(5, p.playLen - 2);
  if (bagRemaining >= 4)  return 3;
  return 2;
}

export function decide(input: BrainInput, p: BrainParams = DEFAULT_PARAMS): Decision {
  const { byLength, counts } = loadLexicon();
  const rc = rackToCounts(input.rack);
  const words: string[] = [];

  if (input.bagRemaining < p.flushAt) {
    // Endgame: play the optimal split of the entire rack.
    for (const i of bestSplit(rc, p.beam).idx) {
      words.push(byLength[i]!);
      take(rc, counts, i);
    }
  } else {
    const minLen = midGameMinLen(input.bagRemaining, p);
    const rackSize = rackTotal(rc);

    // Rack-pressure: if holding too many tiles, play the best word of any length.
    if (rackSize >= p.maxRack) {
      const best = candidates(rc)[0];
      if (best) {
        words.push(byLength[best.idx]!);
        take(rc, counts, best.idx);
      }
    }

    // Mid-game: keep playing words that meet the length threshold.
    for (;;) {
      const c = candidates(rc).find((x) => byLength[x.idx]!.length >= minLen);
      if (!c) break;
      words.push(byLength[c.idx]!);
      take(rc, counts, c.idx);
    }
  }

  // The last letter can never be played: don't waste budget bidding on it.
  if (input.isLastAuction) return { words, bid: 0 };

  // Balance after anticipated word rewards.
  let balance = input.balance;
  for (const w of words) balance += wordReward(w);

  // Marginal gain: how much better is our best rack-split with this letter?
  const before = bestSplit(rc, p.beam).score;
  const withL = [...rc];
  const charCode = input.letter.charCodeAt(0) - 65;
  withL[charCode]!++;
  const gain = bestSplit(withL, p.beam).score - before;

  // Rack balance & synergy heuristics
  let vowelAdj = 0;
  let synAdj = 0;

  const totalTiles = rackTotal(rc);
  const isVowel = "AEIOU".includes(input.letter);
  const countVowels = rc[0]! + rc[4]! + rc[8]! + rc[14]! + rc[20]!; // A, E, I, O, U

  if (totalTiles >= 3) {
    const vowelRatio = countVowels / totalTiles;
    if (vowelRatio < 0.33) {
      vowelAdj = isVowel ? 3.0 : -2.0;
    } else if (vowelRatio > 0.55) {
      vowelAdj = isVowel ? -2.0 : 2.0;
    }
  }

  // Synergy: Q without U is a liability; U for Q is critical
  const hasQ = rc[16]! > 0;
  const hasU = rc[20]! > 0;
  if (hasQ && !hasU && input.letter === "U") {
    synAdj += 5.0;
  }
  if (!hasU && input.letter === "Q" && input.bagRemaining < 35) {
    synAdj -= 4.0;
  }

  // Avoid multiple awkward consonants (J, Q, X, Z)
  const isAwkward = "JQXZ".includes(input.letter);
  const awkwardCount = rc[9]! + rc[16]! + rc[23]! + rc[25]!; // J, Q, X, Z
  if (isAwkward && awkwardCount >= 1) {
    synAdj -= 3.5;
  }

  // Avoid holding 3+ copies of any letter
  if (rc[charCode]! >= 2) {
    synAdj -= 3.0;
  }

  // Bonus for versatile letters S and E
  if (rc[charCode] === 0) {
    if (input.letter === "S") synAdj += 2.0;
    else if (input.letter === "E") synAdj += 1.0;
  }

  const rawValue =
    p.a +
    p.b * letterValue(input.letter) +
    p.c * gain +
    p.vowelWeight * vowelAdj +
    p.synergyWeight * synAdj;

  // Budget pacing: don't stake more than budgetFrac of remaining balance per
  // auction, but allow at least 1 when balance > 0.
  const budgetCap = Math.max(1, Math.floor(balance * p.budgetFrac));

  const bid = Math.max(0, Math.min(Math.floor(rawValue), budgetCap, balance));
  return { words, bid };
}
