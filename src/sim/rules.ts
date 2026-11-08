// Game constants and scoring. Ported from the server module
// (clockworklabs/scrabblebot spacetimedb/src/letters.ts and game.ts).

export const STARTING_BALANCE = 100;
export const STARTING_RACK_SIZE = 5;
export const LOBBY_MAX_SIZE = 6;
export const AUCTION_RESERVE = 1;
export const SIM_BID_JITTER = 2;

export const LETTER_VALUE: Record<string, number> = {
  A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1, J: 8,
  K: 5, L: 1, M: 3, N: 1, O: 1, P: 3, Q: 10, R: 1, S: 1, T: 1,
  U: 1, V: 4, W: 4, X: 8, Y: 4, Z: 10,
};

// Standard Scrabble distribution, no blanks. 98 tiles. Sorted by letter,
// as the server draws from it.
export const DEFAULT_BAG: readonly (readonly [string, number])[] = [
  ["A", 9], ["B", 2], ["C", 2], ["D", 4], ["E", 12], ["F", 2], ["G", 3],
  ["H", 2], ["I", 9], ["J", 1], ["K", 1], ["L", 4], ["M", 2], ["N", 6],
  ["O", 8], ["P", 2], ["Q", 1], ["R", 6], ["S", 4], ["T", 6], ["U", 4],
  ["V", 2], ["W", 2], ["X", 1], ["Y", 2], ["Z", 1],
];

export function letterValue(c: string): number {
  return LETTER_VALUE[c] ?? 0;
}

// Length multiplier as [numerator, denominator].
export function lengthMultiplier(len: number): [number, number] {
  if (len <= 3) return [1, 1];
  if (len === 4) return [3, 2];
  if (len === 5) return [2, 1];
  if (len === 6) return [5, 2];
  return [3, 1];
}

// Reward for a word: base score times multiplier, integer division.
export function wordReward(word: string): number {
  let base = 0;
  for (const c of word) base += letterValue(c);
  const [num, den] = lengthMultiplier(word.length);
  return Math.floor((base * num) / den);
}
