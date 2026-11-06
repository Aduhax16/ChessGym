// Training session logic. No DOM here, so it can be tested on its own.
import { Chess } from '../vendor/chess.js';
import { blendRows, keyOf, rowsFor } from './book.js';

const REFERENCE_MIN_SHARE = 0.1;
const MASTERED_STREAK = 2;
const UNMASTERED_WEIGHT = 3;

export const MODES = { LEARN: 'learn', PRACTICE: 'practice' };

/** Maps each position in an opening's lines to the moves each side plays there. */
export function buildIndex(opening) {
  const index = new Map();
  const userTurn = opening.color === 'white' ? 'w' : 'b';
  for (const line of opening.lines) {
    const chess = new Chess();
    for (const san of line.moves.split(' ')) {
      const key = keyOf(chess.fen());
      if (!index.has(key)) index.set(key, { user: new Set(), rival: new Set() });
      index.get(key)[chess.turn() === userTurn ? 'user' : 'rival'].add(san);
      chess.move(san);
    }
  }
  return index;
}

/** Positions where the user has to answer, as used by the mastery bar. */
export function userPositions(opening) {
  return [...buildIndex(opening)].filter(([, moves]) => moves.user.size > 0).map(([key]) => key);
}

function pickWeighted(items, random) {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let roll = random() * total;
  for (const item of items) {
    roll -= item.weight;
    if (roll <= 0) return item;
  }
  return items[items.length - 1];
}

export class Trainer {
  /**
   * opponent: { rating, mix: [{ id, weight }] }
   * books: { [bandId]: book, reference: book }
   */
  constructor({ opening, opponent, books, progress, mode = MODES.PRACTICE, plies = 20, adaptive = true, random = Math.random }) {
    Object.assign(this, { opening, opponent, books, progress, mode, plies, adaptive, random });
    this.chess = new Chess();
    this.index = buildIndex(opening);
    this.prefix = opening.prefix.split(' ');
    this.userColor = opening.color === 'white' ? 'w' : 'b';
    this.history = [];
    this.moves = []; // verbose chess.js moves, parallel to history
    this.mistakes = 0;
    this.hintsUsed = 0;
    this.answered = 0;
    this.endReason = null;
    this.attempted = false; // user already failed or asked for a hint here
    this._checkEnd();
  }

  get fen() { return this.chess.fen(); }
  get ply() { return this.history.length; }
  get done() { return this.endReason !== null; }
  get isUserTurn() { return !this.done && this.chess.turn() === this.userColor; }
  get inPrefix() { return this.ply < this.prefix.length; }

  /** Moves accepted from the user now, and where that answer comes from. */
  expected() {
    if (this.inPrefix) return { moves: [this.prefix[this.ply]], source: 'prefix' };
    const entry = this.index.get(keyOf(this.fen));
    if (entry?.user.size) return { moves: [...entry.user], source: 'repertoire' };
    const reference = this.referenceRows();
    if (reference.length) return { moves: reference.map((row) => row.san), source: 'reference' };
    return null;
  }

  /** Common moves among strong players in the current position. */
  referenceRows() {
    const rows = this._legal(rowsFor(this.books.reference, this.fen));
    const common = rows.filter((row) => row.share >= REFERENCE_MIN_SHARE);
    return common.length ? common : rows.slice(0, 1);
  }

  /** What this game's opponent would choose from in `fen`. */
  levelRows(fen = this.fen) {
    return blendRows(this.books, this.opponent.mix, fen);
  }

  /** Position keys ignore en passant, so a counted move can occasionally be illegal here. */
  _legal(rows) {
    const legal = new Set(this.chess.moves());
    return rows.filter((row) => legal.has(row.san));
  }

  tryMove(san) {
    const expected = this.expected();
    if (!expected.moves.includes(san)) {
      this.mistakes += this.attempted ? 0 : 1;
      this.attempted = true;
      const playable = rowsFor(this.books.reference, this.fen)
        .find((row) => row.san === san && row.share >= REFERENCE_MIN_SHARE);
      return { ok: false, source: expected.source, expected: expected.moves, playable };
    }
    if (expected.source !== 'reference' && this.mode === MODES.PRACTICE) {
      this.progress?.record(this.opening.id, keyOf(this.fen), !this.attempted);
    }
    this.answered += 1;
    this.attempted = false;
    this._play(san);
    return { ok: true, source: expected.source };
  }

  /** Marks the current position as helped, so it does not count as known. */
  useHint() {
    if (!this.attempted) this.hintsUsed += 1;
    this.attempted = true;
    return this.expectedMoveDetails();
  }

  expectedMoveDetails() {
    const expected = this.expected();
    if (!expected) return null;
    return this.chess.moves({ verbose: true }).find((move) => move.san === expected.moves[0]) ?? null;
  }

  rivalCandidates() {
    if (this.inPrefix) return [{ san: this.prefix[this.ply], weight: 1, forced: true }];
    const rows = this._legal(this.levelRows());
    if (rows.length) {
      return rows.map((row) => ({ san: row.san, weight: row.share * this._adaptiveFactor(row.san), row }));
    }
    const entry = this.index.get(keyOf(this.fen));
    if (entry?.rival.size) return [...entry.rival].map((san) => ({ san, weight: 1 }));
    return this.referenceRows().map((row) => ({ san: row.san, weight: row.games, row }));
  }

  /** Makes moves leading to not-yet-mastered lines more likely, if adaptive mode is on. */
  _adaptiveFactor(san) {
    if (!this.adaptive || !this.progress) return 1;
    const probe = new Chess(this.fen);
    probe.move(san);
    const key = keyOf(probe.fen());
    if (!this.index.get(key)?.user.size) return 1;
    return this.progress.streak(this.opening.id, key) < MASTERED_STREAK ? UNMASTERED_WEIGHT : 1;
  }

  playRival() {
    const choice = pickWeighted(this.rivalCandidates(), this.random);
    const before = this.fen;
    this._play(choice.san);
    return { san: choice.san, before, forced: Boolean(choice.forced), row: choice.row };
  }

  summary() {
    return {
      answered: this.answered,
      mistakes: this.mistakes,
      hints: this.hintsUsed,
      clean: this.mistakes === 0 && this.hintsUsed === 0,
      endReason: this.endReason,
    };
  }

  /** The written lines that still match the moves played so far. */
  matchingLines() {
    const played = this.history.join(' ');
    return this.opening.lines.filter((line) => line.moves === played || line.moves.startsWith(`${played} `));
  }

  _play(san) {
    this.moves.push(this.chess.move(san));
    this.history.push(san);
    this._checkEnd();
  }

  _checkEnd() {
    if (this.ply >= this.plies) this.endReason = 'complete';
    else if (this.chess.isGameOver()) this.endReason = 'gameOver';
    else if (this.chess.turn() === this.userColor) {
      if (!this.expected()) this.endReason = 'noReference';
    } else if (!this.rivalCandidates().length) this.endReason = 'noData';
    if (this.endReason && this.mode === MODES.PRACTICE) {
      this.progress?.finish(this.opening.id, this.summary().clean);
    }
  }
}
