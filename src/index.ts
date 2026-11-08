// ScrabbleBot bot starter.
//
// First run, with a token from the website:
//   On your team's page, click "Generate token", then run
//   `BOT_NAME=<name> BOT_TOKEN=<token> npm start`.
//
// Or with a nonce from the CLI:
//   1. `spacetime call scrabblebot mint_credential_nonce`
//      `spacetime sql 'SELECT code FROM my_nonces ORDER BY expires_at DESC'`
//   2. `BOT_NAME=<name> BOT_NONCE=<code> npm start`
//      The bot connects fresh and redeems the nonce.
//
// Either way the bot saves its token to .token-<BOT_NAME>, so later runs
// need only `BOT_NAME=<name> npm start`.
//
// Entering a tournament: `BOT_NAME=<name> TOURNAMENT_ID=<id> npm start`
// registers the bot for that tournament when it connects. Only the bot
// itself can register, so this has to come from the bot's process.
//
// Strategy lives in ./src/brain.ts. Test changes with `npm run sim`.

import {
  DbConnection,
  type EventContext,
  type ErrorContext,
} from "./module_bindings/index.js";
import { Identity } from "spacetimedb";
import * as fs from "node:fs";
import * as path from "node:path";
import { decide } from "./brain.js";
import { loadLexicon } from "./sim/dictionary.js";
import { display } from "./display.js";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "bot";
const BOT_TOKEN = process.env.BOT_TOKEN; // from the website, first run only
const BOT_NONCE = process.env.BOT_NONCE; // from the CLI, first run only
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
const TOKEN_PATH = path.join(process.cwd(), `.token-${BOT_NAME}`);

function loadToken(): string | undefined {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
function saveToken(tok: string) {
  fs.writeFileSync(TOKEN_PATH, tok);
}

// Load the wordlist now, not in the first auction window.
loadLexicon();

let myIdentity: Identity | null = null;
let myBotId: bigint | null = null;
const handledAuctions = new Set<string>();
// Our matches: match id -> our match_participant row id. The tables hold
// every match on the server, so do not scan them per event.
const myMatches = new Map<bigint, bigint>();

function resolveMyBotId(conn: DbConnection): bigint | null {
  if (!myIdentity) return null;
  const cred = conn.db.botCredential.identity.find(myIdentity);
  return cred ? cred.botId : null;
}

// One full scan, at start. After this, matchParticipant.onInsert keeps
// myMatches current.
function indexMyMatches(conn: DbConnection) {
  if (myBotId === null) return;
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.botId === myBotId) myMatches.set(p.matchId, p.id);
  }
}

function isRunning(conn: DbConnection, matchId: bigint): boolean {
  return conn.db.matchState.id.find(matchId)?.status.tag === "Running";
}

function getActiveMatchId(conn: DbConnection): bigint | null {
  for (const matchId of myMatches.keys()) {
    if (isRunning(conn, matchId)) return matchId;
  }
  return null;
}

function syncDashboard(conn: DbConnection) {
  const matchId = getActiveMatchId(conn);
  if (matchId !== null) {
    const participant = participantForMatch(conn, matchId);
    const rack = rackForMatch(conn, matchId);
    display.update({
      status: "In Match",
      matchId,
      score: participant?.score ?? 0,
      balance: participant?.balance ?? 0,
      rack,
    });
  } else {
    display.update({
      status: "In Lobby / Waiting",
      matchId: null,
      rack: new Map(),
    });
  }
}

function rackForMatch(
  conn: DbConnection,
  matchId: bigint,
): Map<string, number> {
  const rack = new Map<string, number>();
  for (const h of conn.db.myRack.iter()) {
    if (h.matchId !== matchId) continue;
    rack.set(h.letter, (rack.get(h.letter) ?? 0) + h.count);
  }
  return rack;
}

function participantForMatch(
  conn: DbConnection,
  matchId: bigint,
): { balance: number; score: number } | null {
  const rowId = myMatches.get(matchId);
  if (rowId === undefined) return null;
  const p = conn.db.matchParticipant.id.find(rowId);
  return p ? { balance: Number(p.balance), score: Number(p.score) } : null;
}

// A reducer call fails when the module refuses it, often for an expected
// reason: a word played just after its match ended, a bid that missed the
// auction's window. Log it and keep playing; an uncaught failure would stop
// the bot.
function logFailure(what: string) {
  return (err: unknown) =>
    display.warn(
      `${what} failed: ${err instanceof Error ? err.message : err}`,
    );
}

// Decide once per open auction: play words, then bid. Words go first so
// their reward can fund the bid.
function actOnAuction(
  conn: DbConnection,
  auctionId: bigint,
  matchId: bigint,
  letter: string,
) {
  if (myBotId === null || !myMatches.has(matchId)) return;
  const key = `${matchId}:${auctionId}`;
  if (handledAuctions.has(key)) return;
  const match = conn.db.matchState.id.find(matchId);
  if (match?.status.tag !== "Running") return;
  const participant = participantForMatch(conn, matchId);
  if (!participant) {
    display.warn(`match ${matchId}: no participant row`);
    return;
  }
  handledAuctions.add(key);

  const t0 = performance.now();
  const d = decide({
    rack: rackForMatch(conn, matchId),
    letter,
    bagRemaining: match.bagTotal,
    isLastAuction: match.bagTotal === 0,
    balance: participant.balance,
  });
  const ms = (performance.now() - t0).toFixed(0);

  for (const word of d.words) {
    conn.reducers
      .submitWord({ matchId, word })
      .catch(logFailure(`playing '${word}'`));
    display.update({ lastWord: word });
    display.log(`Match ${matchId}: played '${word}'`);
  }
  if (d.bid > 0) {
    conn.reducers
      .submitBid({ auctionId, amount: BigInt(d.bid) })
      .catch((err: unknown) => {
        logFailure(`bid ${d.bid} on auction ${auctionId}`)(err);
        // A word in this batch may have failed. Bid what we have.
        const retry = Math.min(d.bid, participantForMatch(conn, matchId)?.balance ?? 0);
        if (retry > 0 && retry < d.bid) {
          conn.reducers
            .submitBid({ auctionId, amount: BigInt(retry) })
            .catch(logFailure(`retry bid ${retry}`));
        }
      });
  }
  display.log(
    `Match ${matchId} r${match.currentRound} '${letter}': bid ${d.bid} (bag ${match.bagTotal}, ${ms}ms)`,
  );
  syncDashboard(conn);
}

function onConnect(conn: DbConnection, identity: Identity, token: string) {
  myIdentity = identity;
  saveToken(token);
  display.log(`Connected (${identity.toHexString().slice(0, 10)}…)`);

  const finishConnect = () => {
    // Resolve our bot id, possibly after claiming a nonce.
    myBotId = resolveMyBotId(conn);
    if (myBotId === null) {
      if (BOT_NONCE) {
        display.log("Claiming credential with nonce…");
        conn.reducers
          .claimCredential({ code: BOT_NONCE })
          .catch(logFailure("claiming the credential"));
        // Wait briefly for the credential to land; check again.
        setTimeout(() => {
          myBotId = resolveMyBotId(conn);
          if (myBotId === null) {
            display.warn("Couldn't claim credential. Bad / expired nonce?");
            process.exit(1);
          }
          const bot = conn.db.bot.id.find(myBotId);
          const actualName = bot?.name ?? BOT_NAME;
          display.update({ botName: actualName, botId: myBotId, status: "Ready" });
          display.log(
            `Claimed credential for bot '${actualName}' (id ${myBotId})`,
          );
          bootstrapActivity(conn);
        }, 1000);
        return;
      } else {
        display.warn("No BotCredential for this token. Set BOT_TOKEN or BOT_NONCE and re-run.");
        process.exit(1);
      }
    }

    const bot = conn.db.bot.id.find(myBotId);
    const actualName = bot?.name ?? BOT_NAME;
    display.update({ botName: actualName, botId: myBotId, status: "Ready" });
    display.log(`Acting as bot '${actualName}' (id ${myBotId})`);
    bootstrapActivity(conn);
  };

  // Subscribe in two fast phases to avoid downloading millions of historical auctions.
  conn
    .subscriptionBuilder()
    .onApplied(() => {
      display.log("Core tables synced");

      // Find highest match ID so we only replicate active & recent auctions
      let maxMatchId = 0n;
      for (const m of conn.db.matchState.iter()) {
        if (m.id > maxMatchId) maxMatchId = m.id;
      }
      const minMatchId = maxMatchId > 10n ? maxMatchId - 10n : 0n;

      conn
        .subscriptionBuilder()
        .onApplied(() => {
          display.log("Live auctions synced");
          finishConnect();
        })
        .onError((ctx: ErrorContext) => {
          display.warn(`Auction sync error`);
          finishConnect();
        })
        .subscribe([
          `SELECT * FROM auction WHERE match_id >= ${minMatchId}`,
          `SELECT * FROM auction_result WHERE match_id >= ${minMatchId}`,
        ]);
    })
    .onError((ctx: ErrorContext) => {
      display.warn(`Subscription error`);
    })
    .subscribe([
      "SELECT * FROM bot",
      "SELECT * FROM bot_credential",
      "SELECT * FROM match_state",
      "SELECT * FROM match_participant",
      "SELECT * FROM my_rack",
      "SELECT * FROM lobby",
      "SELECT * FROM lobby_member",
    ]);

  conn.db.matchParticipant.onInsert((_ctx, p) => {
    if (myBotId !== null && p.botId === myBotId) {
      myMatches.set(p.matchId, p.id);
      display.log(`Seated in match ${p.matchId}`);
    }
  });
  conn.db.auction.onInsert((_ctx: EventContext, a) => {
    if (a.status.tag !== "Open") return;
    const lagMs = Date.now() - Number(a.opensAt.microsSinceUnixEpoch / 1000n);
    // Let the rest of this transaction (our seat, rack, balance) reach the
    // cache before the myMatches check.
    setImmediate(() => {
      if (!myMatches.has(a.matchId)) return;
      if (lagMs > 300) display.warn(`auction ${a.id} seen ${lagMs}ms after open`);
      try {
        actOnAuction(conn, a.id, a.matchId, a.letter);
      } catch (err) {
        display.warn(`auction ${a.id}: ${err instanceof Error ? err.stack : err}`);
      }
    });
  });
  conn.db.myRack.onInsert(() => syncDashboard(conn));
  conn.db.myRack.onUpdate(() => syncDashboard(conn));
  conn.db.botCredential.onInsert(() => {
    if (myBotId === null) {
      myBotId = resolveMyBotId(conn);
      if (myBotId !== null) display.update({ botId: myBotId });
    }
  });
  conn.db.auctionResult.onInsert((_ctx, r) => {
    if (myBotId === null || !myMatches.has(r.matchId)) return;
    const winner =
      r.winnerBotId !== undefined && r.winnerBotId !== null
        ? (r.winnerBotId === myBotId ? "YOU" : `bot ${r.winnerBotId}`)
        : "no-bid";
    display.log(`Auction ${r.auctionId} '${r.letter}' → ${winner} paid ${r.paid}`);
    syncDashboard(conn);
  });

  // When a match this bot was in ends, hop back into the lobby.
  conn.db.matchState.onUpdate((_ctx, old, neu) => {
    if (myBotId === null) return;
    if (old.status.tag !== "Ended" && neu.status.tag === "Ended") {
      if (myMatches.has(neu.id)) {
        const p = participantForMatch(conn, neu.id);
        display.log(`Match ${neu.id} ended: score ${p?.score}, balance ${p?.balance}; rejoining lobby`);
        display.update({ status: "Match Ended", matchId: null });
        joinLobby(conn);
      }
    }
  });
}

function joinLobby(conn: DbConnection) {
  if (myBotId === null) return;
  if (getActiveMatchId(conn) !== null) return;
  const openLobby = Array.from(conn.db.lobby.iter()).find(
    (l) => l.status.tag === "Open",
  );
  const alreadyIn =
    openLobby !== undefined &&
    Array.from(conn.db.lobbyMember.iter()).some(
      (lm) => lm.lobbyId === openLobby.id && lm.botId === myBotId,
    );
  if (alreadyIn) return;
  display.log("Joining open lobby...");
  display.update({ status: "Joining Lobby" });
  conn.reducers.joinLobby({}).catch(logFailure("joining the lobby"));
}

function bootstrapActivity(conn: DbConnection) {
  if (TOURNAMENT_ID) {
    conn.reducers
      .registerForTournament({ tournamentId: BigInt(TOURNAMENT_ID) })
      .then(() =>
        display.log(`Registered for tournament ${TOURNAMENT_ID}`),
      )
      .catch(logFailure(`registering for tournament ${TOURNAMENT_ID}`));
  }
  indexMyMatches(conn);
  joinLobby(conn);
  for (const a of conn.db.auction.iter()) {
    if (a.status.tag === "Open") actOnAuction(conn, a.id, a.matchId, a.letter);
  }
}

function main() {
  display.init(BOT_NAME);
  display.log(`Connecting to ${DB_NAME} at ${HOST}`);
  DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .withToken(BOT_TOKEN ?? loadToken())
    .onConnect(onConnect)
    .onConnectError((_ctx: ErrorContext, err: Error) =>
      display.warn(`Connect error: ${err.message}`),
    )
    .onDisconnect(() => {
      display.update({ status: "Disconnected" });
      display.warn("Disconnected");
    })
    .build();
}

main();
