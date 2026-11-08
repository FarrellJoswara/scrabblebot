// Checks that the engine follows the server rules.

import assert from "node:assert/strict";
import { test } from "node:test";
import { findBestPlayable, isValidWord } from "./dictionary.js";
import { runMatch, simBid, type BotPlayer, type View } from "./engine.js";
import { sim } from "./players.js";
import { wordReward } from "./rules.js";

// A bot that runs a fixed script per round.
function scripted(
  name: string,
  fn: (v: View) => { words?: string[]; bid?: number },
): BotPlayer {
  return { kind: "bot", name, act: fn };
}

test("wordReward uses the length multiplier with integer division", () => {
  assert.equal(wordReward("CAT"), 5); // 5 x 1
  assert.equal(wordReward("QUIZ"), 33); // 22 x 1.5
  assert.equal(wordReward("TOTE"), 6); // 4 x 1.5
  assert.equal(wordReward("TOTES"), 10); // 5 x 2
  assert.equal(wordReward("ROTATE"), 15); // 6 x 2.5
  assert.equal(wordReward("ROTATES"), 21); // 7 x 3
  assert.equal(wordReward("ZOA"), 12); // 12 x 1
  assert.equal(wordReward("AXE"), 10);
  assert.equal(wordReward("ZOEA"), 19); // 13 x 1.5 = 19.5, floored
});

test("full match runs 98 - 6*5 = 68 auctions", () => {
  const res = runMatch(
    Array.from({ length: 6 }, (_, i) => sim(`s${i}`, "ValueBidder")),
    { seed: 3 },
  );
  assert.equal(res.rounds, 68);
});

test("Vickrey: winner pays second bid; lone bidder pays reserve", () => {
  // Deal: A gets AAAAA, B gets EEEEE. Auctions: T, S.
  const drawOrder = [..."AAAAAEEEEE", "T", "S"];
  const a = scripted("a", (v) => ({ bid: v.round === 1 ? 9 : 4 }));
  const b = scripted("b", (v) => ({ bid: v.round === 1 ? 3 : 0 }));
  const res = runMatch([a, b], { seed: 1, drawOrder });
  assert.deepEqual(
    res.history.map((h) => [h.winner, h.paid]),
    [
      [0, 3],
      [0, 1],
    ],
  );
  assert.equal(res.seats[0]!.balance, 100 - 3 - 1);
});

test("FirstPrice: winner pays own bid", () => {
  const drawOrder = [..."AAAAAEEEEE", "T"];
  const a = scripted("a", () => ({ bid: 9 }));
  const b = scripted("b", () => ({ bid: 3 }));
  const res = runMatch([a, b], { seed: 1, drawOrder, auctionType: "FirstPrice" });
  assert.equal(res.history[0]!.paid, 9);
});

test("bid above balance is refused", () => {
  const drawOrder = [..."AAAAAEEEEE", "T"];
  const a = scripted("a", () => ({ bid: 101 }));
  const b = scripted("b", () => ({ bid: 2 }));
  const res = runMatch([a, b], { seed: 1, drawOrder });
  assert.equal(res.history[0]!.winner, 1);
  assert.equal(res.seats[0]!.rejected, 1);
});

test("words in the last window count; the last letter won is lost", () => {
  // A holds CATSX. Auctions: E (last). A plays CATS in the last window,
  // then wins E but cannot play it.
  const drawOrder = [..."CATSX", ..."IIIII", "E"];
  const a = scripted("a", (v) => {
    assert.equal(v.isLastAuction, true);
    return { words: ["CATS"], bid: 5 };
  });
  const b = scripted("b", () => ({}));
  const res = runMatch([a, b], { seed: 1, drawOrder });
  assert.equal(res.seats[0]!.score, wordReward("CATS"));
  assert.equal(res.seats[0]!.lettersLeft, 2); // X and E
  assert.equal(res.seats[0]!.place, 1);
});

test("invalid word and missing letters are refused without change", () => {
  const drawOrder = [..."CATSX", ..."IIIII", "E"];
  const a = scripted("a", () => ({ words: ["XYZZY", "CATE", "ZZ"] }));
  const res = runMatch([a, scripted("b", () => ({}))], { seed: 1, drawOrder });
  assert.equal(res.seats[0]!.score, 0);
  assert.equal(res.seats[0]!.rejected, 3);
});

test("sim winner plays its longest 3+ letter word at once", () => {
  // Sim holds RATES (5). Wins T in round 1 and plays a 6-letter word.
  const drawOrder = [..."RATES", ..."IIIII", "T", "E"];
  const res = runMatch(
    [sim("s", "Aggressive"), scripted("b", () => ({}))],
    { seed: 1, drawOrder },
  );
  const play = res.plays.find((p) => p.seat === 0)!;
  assert.equal(play.round, 1);
  assert.equal(play.word.length, 6);
});

test("simBid matches the server formula", () => {
  assert.equal(simBid("Cheapskate", "A", 100, 0), 1); // max(0, 1)
  assert.equal(simBid("Cheapskate", "Q", 100, -2), 7);
  assert.equal(simBid("ValueBidder", "K", 100, 1), 6);
  assert.equal(simBid("Aggressive", "E", 100, 2), 7); // 1+4+2
  assert.equal(simBid("Aggressive", "Z", 100, 0), 12);
  assert.equal(simBid("Aggressive", "Z", 5, 0), 5); // capped by balance
  assert.equal(simBid("ValueBidder", "Z", 0, 0), 0);
});

test("findBestPlayable returns the longest word, lex-first", () => {
  const rack = (s: string) => {
    const m = new Map<string, number>();
    for (const c of s) m.set(c, (m.get(c) ?? 0) + 1);
    return m;
  };
  const w = findBestPlayable(rack("RETAINS"), 3)!;
  assert.equal(w.length, 7);
  assert.ok(isValidWord(w));
  assert.equal(findBestPlayable(rack("QXZ"), 3), undefined);
  assert.equal(findBestPlayable(rack("AT"), 3), undefined);
});
