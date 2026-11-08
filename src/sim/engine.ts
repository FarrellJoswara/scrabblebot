// Offline match engine. Follows the server's startMatchWith, closeAuction,
// playWord and sim-bot logic (spacetimedb/src/game.ts).
//
// Round model:
//   1. An auction opens. Sim bots bid at once.
//   2. Each external bot acts once in the auction window: it can play words,
//      then bid. Words go first, so their reward can fund the bid.
//   3. The auction closes. The winner gets the letter. A sim winner plays
//      its longest 3+ letter word at once.
//   4. If the bag is empty, the match ends. Letters still in racks are lost.

import { findBestPlayable, isValidWord } from "./dictionary.js";
import { Rng } from "./rng.js";
import {
  AUCTION_RESERVE,
  DEFAULT_BAG,
  letterValue,
  SIM_BID_JITTER,
  STARTING_BALANCE,
  STARTING_RACK_SIZE,
  wordReward,
} from "./rules.js";

export type AuctionType = "Vickrey" | "FirstPrice";
export type SimStrategy = "Cheapskate" | "ValueBidder" | "Aggressive";

export interface AuctionRecord {
  round: number;
  letter: string;
  winner: number | null; // seat
  paid: number;
}

export interface PlayRecord {
  round: number;
  seat: number;
  word: string;
  reward: number;
}

export interface Standing {
  seat: number;
  name: string;
  isSim: boolean;
  balance: number;
  score: number;
}

// What a live bot can see while an auction is open.
export interface View {
  seat: number;
  round: number; // 1-based
  letter: string; // letter on auction
  bagRemaining: number; // tiles left in the bag after this one
  isLastAuction: boolean; // last chance to play words
  auctionType: AuctionType;
  startingRackSize: number;
  rack: ReadonlyMap<string, number>;
  balance: number;
  score: number;
  standings: readonly Standing[];
  history: readonly AuctionRecord[];
  plays: readonly PlayRecord[];
}

export interface Action {
  words?: string[];
  bid?: number;
}

export interface BotPlayer {
  kind: "bot";
  name: string;
  // Called once at match start.
  reset?(seat: number, seats: number): void;
  act(view: View): Action;
}

export interface SimPlayer {
  kind: "sim";
  name: string;
  strategy: SimStrategy;
}

export type Player = BotPlayer | SimPlayer;

export interface MatchOptions {
  seed: number;
  auctionType?: AuctionType;
  startingRackSize?: number;
  // Test only: fixed draw order. Deal first, then auctions.
  drawOrder?: string[];
}

export interface SeatResult {
  name: string;
  score: number;
  balance: number;
  place: number; // 1 = best; ties share the place
  lettersLeft: number; // tiles lost at match end
  rejected: number; // refused words or bids
}

export interface MatchResult {
  rounds: number;
  seats: SeatResult[];
  history: AuctionRecord[];
  plays: PlayRecord[];
}

interface Seat {
  player: Player;
  rack: Map<string, number>;
  balance: number;
  score: number;
  rejected: number;
}

class Bag {
  private counts: Map<string, number>;
  private order?: string[];
  total: number;

  constructor(
    private rng: Rng,
    order?: string[],
  ) {
    this.counts = new Map(DEFAULT_BAG.map(([l, n]) => [l, n]));
    this.total = order ? order.length : [...this.counts.values()].reduce((a, b) => a + b, 0);
    this.order = order ? [...order] : undefined;
  }

  draw(): string | undefined {
    if (this.total === 0) return undefined;
    if (this.order) {
      this.total--;
      return this.order.shift();
    }
    let idx = this.rng.int(0, this.total - 1);
    for (const [l, n] of this.counts) {
      if (idx < n) {
        this.counts.set(l, n - 1);
        this.total--;
        return l;
      }
      idx -= n;
    }
    return undefined;
  }
}

export function simBid(
  strategy: SimStrategy,
  letter: string,
  balance: number,
  jitter: number,
): number {
  const value = letterValue(letter);
  const isVowel = "AEIOU".includes(letter);
  let base: number;
  switch (strategy) {
    case "Cheapskate":
      base = value - 1;
      break;
    case "ValueBidder":
      base = value;
      break;
    case "Aggressive":
      base = value + (isVowel ? 4 : 2);
      break;
  }
  return Math.max(Math.min(Math.max(base + jitter, 1), balance), 0);
}

function addLetter(rack: Map<string, number>, l: string) {
  rack.set(l, (rack.get(l) ?? 0) + 1);
}

// Spend letters and pay the reward. Returns false and changes nothing if
// the word is not valid or the rack lacks letters.
function playWord(seat: Seat, word: string): number | null {
  const w = word.toUpperCase();
  if (w.length < 2 || !/^[A-Z]+$/.test(w) || !isValidWord(w)) return null;
  const need = new Map<string, number>();
  for (const c of w) need.set(c, (need.get(c) ?? 0) + 1);
  for (const [c, n] of need) if ((seat.rack.get(c) ?? 0) < n) return null;
  for (const [c, n] of need) {
    const left = seat.rack.get(c)! - n;
    if (left === 0) seat.rack.delete(c);
    else seat.rack.set(c, left);
  }
  const reward = wordReward(w);
  seat.balance += reward;
  seat.score += reward;
  return reward;
}

export function runMatch(players: Player[], opts: MatchOptions): MatchResult {
  const rng = new Rng(opts.seed);
  const auctionType = opts.auctionType ?? "Vickrey";
  const rackSize = opts.startingRackSize ?? STARTING_RACK_SIZE;
  const bag = new Bag(rng, opts.drawOrder);
  const history: AuctionRecord[] = [];
  const plays: PlayRecord[] = [];

  const seats: Seat[] = players.map((player) => ({
    player,
    rack: new Map(),
    balance: STARTING_BALANCE,
    score: 0,
    rejected: 0,
  }));
  seats.forEach((s, i) => {
    if (s.player.kind === "bot") s.player.reset?.(i, seats.length);
  });

  for (const s of seats) {
    for (let n = 0; n < rackSize; n++) {
      const l = bag.draw();
      if (l === undefined) break;
      addLetter(s.rack, l);
    }
  }

  const standings = (): Standing[] =>
    seats.map((s, i) => ({
      seat: i,
      name: s.player.name,
      isSim: s.player.kind === "sim",
      balance: s.balance,
      score: s.score,
    }));

  let round = 0;
  let letter = bag.draw();
  while (letter !== undefined) {
    round++;
    const bids = new Map<number, number>();

    // Sims bid when the auction opens.
    seats.forEach((s, i) => {
      if (s.player.kind !== "sim") return;
      const jitter = rng.int(-SIM_BID_JITTER, SIM_BID_JITTER);
      const amount = simBid(s.player.strategy, letter!, s.balance, jitter);
      if (amount > 0) bids.set(i, amount);
    });

    // External bots act in the window.
    seats.forEach((s, i) => {
      if (s.player.kind !== "bot") return;
      const action = s.player.act({
        seat: i,
        round,
        letter: letter!,
        bagRemaining: bag.total,
        isLastAuction: bag.total === 0,
        auctionType,
        startingRackSize: rackSize,
        rack: new Map(s.rack),
        balance: s.balance,
        score: s.score,
        standings: standings(),
        history,
        plays,
      });
      for (const w of action.words ?? []) {
        const reward = playWord(s, w);
        if (reward === null) s.rejected++;
        else plays.push({ round, seat: i, word: w.toUpperCase(), reward });
      }
      const amount = Math.floor(action.bid ?? 0);
      if (amount < 0 || amount > s.balance) s.rejected++;
      else if (amount > 0) bids.set(i, amount);
    });

    // Close: shuffle, then stable sort by amount desc.
    const sorted = [...bids.entries()];
    rng.shuffle(sorted);
    sorted.sort((a, b) => b[1] - a[1]);
    let winner: number | null = null;
    let paid = 0;
    const [first, second] = sorted;
    if (first) {
      winner = first[0];
      paid =
        auctionType === "FirstPrice"
          ? first[1]
          : second
            ? second[1]
            : Math.min(AUCTION_RESERVE, first[1]);
      const s = seats[winner]!;
      s.balance -= paid;
      addLetter(s.rack, letter);
    }
    history.push({ round, letter, winner, paid });

    // A sim winner plays its longest 3+ letter word.
    if (winner !== null) {
      const s = seats[winner]!;
      if (s.player.kind === "sim") {
        const w = findBestPlayable(s.rack, 3);
        if (w) {
          const reward = playWord(s, w)!;
          plays.push({ round, seat: winner, word: w, reward });
        }
      }
    }

    letter = bag.draw();
  }

  const results: SeatResult[] = seats.map((s) => ({
    name: s.player.name,
    score: s.score,
    balance: s.balance,
    place: 1 + seats.filter((o) => o.score > s.score).length,
    lettersLeft: [...s.rack.values()].reduce((a, b) => a + b, 0),
    rejected: s.rejected,
  }));
  return { rounds: round, seats: results, history, plays };
}
