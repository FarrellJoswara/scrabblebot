// High-performance bidding and word-forming strategy for ScrabbleBot.

// Standard Scrabble letter values.
export const LETTER_VALUE: Record<string, number> = {
  A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1, J: 8,
  K: 5, L: 1, M: 3, N: 1, O: 1, P: 3, Q: 10, R: 1, S: 1, T: 1,
  U: 1, V: 4, W: 4, X: 8, Y: 4, Z: 10,
};

const VOWELS = new Set(["A", "E", "I", "O", "U"]);
const HIGH_VALUE_CONSONANTS = new Set(["J", "Q", "X", "Z"]);

export interface BidContext {
  letter: string;              // Letter being auctioned, e.g. "Q"
  myBalance: number;           // Current coin balance
  myRack: Map<string, number>; // Letters currently owned, letter -> count
}

/**
 * Intelligent bidding strategy that balances:
 * 1. Rack vowel/consonant health (avoids unplayable consonant clogs)
 * 2. Letter synergies (high priority for U when holding Q)
 * 3. Avoiding duplicate awkward consonants (never buy multiple Q, J, X, Z)
 * 4. Coin budget pacing (saves money when balance is running low)
 */
export function decideBid(ctx: BidContext): number {
  if (ctx.myBalance <= 0) return 0;

  const letter = ctx.letter.toUpperCase();
  const faceValue = LETTER_VALUE[letter] ?? 1;
  const have = ctx.myRack.get(letter) ?? 0;

  // Never buy duplicates of awkward high-point tiles (Q, J, X, Z)
  if (HIGH_VALUE_CONSONANTS.has(letter) && have >= 1) {
    return 0;
  }

  // Avoid holding 3 or more of any identical letter
  if (have >= 2) {
    return 0;
  }

  // Calculate current rack vowel/consonant balance
  let totalTiles = 0;
  let vowelCount = 0;
  let consonantCount = 0;
  for (const [char, count] of ctx.myRack.entries()) {
    totalTiles += count;
    if (VOWELS.has(char)) vowelCount += count;
    else consonantCount += count;
  }

  let valuation = faceValue;

  // Synergy: Desperately need 'U' if we hold 'Q'
  const hasQ = (ctx.myRack.get("Q") ?? 0) > 0;
  const hasU = (ctx.myRack.get("U") ?? 0) > 0;
  if (hasQ && !hasU && letter === "U") {
    valuation += 4;
  }

  // Versatile tile bonuses (S, E, A form easy plurals and words)
  if (have === 0 && (letter === "S" || letter === "E")) {
    valuation += 1;
  }

  // Vowel / Consonant balancing heuristics
  const isVowel = VOWELS.has(letter);
  if (totalTiles >= 3) {
    const vowelRatio = vowelCount / totalTiles;
    if (vowelRatio < 0.3) {
      // Rack is starved of vowels: pay a premium for vowels, avoid consonants
      if (isVowel) valuation += 3;
      else valuation = Math.max(0, valuation - 2);
    } else if (vowelRatio > 0.6) {
      // Rack has too many vowels: pay less for vowels, favor consonants
      if (isVowel) valuation = Math.max(1, valuation - 2);
      else valuation += 2;
    }
  }

  // Premium for letters we don't have yet (unless penalized by balance)
  if (have === 0 && valuation >= faceValue) {
    valuation += 1;
  }

  // Budget management: don't exhaust all coins on non-essential tiles
  if (ctx.myBalance <= 3 && !isVowel && !(hasQ && !hasU && letter === "U")) {
    valuation = Math.min(valuation, 1);
  }

  const finalBid = Math.min(valuation, ctx.myBalance);
  return Math.max(0, Math.floor(finalBid));
}

export interface WordContext {
  myRack: Map<string, number>;
  dictionary: string[]; // Uppercase list
}

// In-memory Trie node for sub-millisecond rack searches.
class TrieNode {
  word: string | null = null;
  children: Map<string, TrieNode> = new Map();
}

// Cache built Tries by dictionary array reference.
const trieCache = new WeakMap<string[], TrieNode>();

function getOrCreateTrie(dictionary: string[]): TrieNode {
  let root = trieCache.get(dictionary);
  if (root) return root;

  root = new TrieNode();
  for (let i = 0; i < dictionary.length; i++) {
    const word = dictionary[i];
    let curr = root;
    for (let j = 0; j < word.length; j++) {
      const c = word[j];
      let next = curr.children.get(c);
      if (!next) {
        next = new TrieNode();
        curr.children.set(c, next);
      }
      curr = next;
    }
    curr.word = word;
  }

  trieCache.set(dictionary, root);
  return root;
}

function wordScore(word: string): number {
  let score = 0;
  for (let i = 0; i < word.length; i++) {
    score += LETTER_VALUE[word[i]] ?? 1;
  }
  return score;
}

function searchTrie(node: TrieNode, rack: Map<string, number>): string | null {
  let best = node.word;
  let bestScore = best ? wordScore(best) : 0;

  for (const [letter, count] of rack.entries()) {
    if (count > 0) {
      const next = node.children.get(letter);
      if (next) {
        rack.set(letter, count - 1);
        const candidate = searchTrie(next, rack);
        rack.set(letter, count);

        if (candidate) {
          const candLen = candidate.length;
          const bestLen = best ? best.length : 0;
          if (candLen > bestLen) {
            best = candidate;
            bestScore = wordScore(candidate);
          } else if (candLen === bestLen) {
            const candScore = wordScore(candidate);
            if (candScore > bestScore) {
              best = candidate;
              bestScore = candScore;
            }
          }
        }
      }
    }
  }

  return best;
}

/**
 * Sub-millisecond word finder (< 1ms).
 * Traverses an indexed prefix tree (Trie) using available rack tiles,
 * returning the longest playable word, breaking ties by highest point score.
 */
export function chooseWord(ctx: WordContext): string | null {
  let totalTiles = 0;
  for (const count of ctx.myRack.values()) totalTiles += count;
  if (totalTiles < 2) return null;

  const root = getOrCreateTrie(ctx.dictionary);
  return searchTrie(root, ctx.myRack);
}
