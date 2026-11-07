// Game review logic: asks the engine about every position of a finished game,
// then grades each move by how much it lowered the mover's expected score.
// No DOM here, so it can be tested on its own.
import { Chess } from '../vendor/chess.js';

// Maximum share of expected score (0-100) a move can give away in each class.
const LOSS_LIMITS = [
  ['excellent', 2],
  ['good', 5],
  ['inaccuracy', 10],
  ['mistake', 20],
];
// How common a move must be among strong players to count as opening theory,
// and how much it may give away and still be called that.
const BOOK_MIN_SHARE = 0.03;
const BOOK_MAX_LOSS = 10;
const LINE_LENGTH = 6;

export const CLASSES = {
  best: { label: 'Best', glyph: '★' },
  excellent: { label: 'Excellent', glyph: '!' },
  good: { label: 'Good', glyph: '✓' },
  book: { label: 'Book', glyph: '≡' },
  inaccuracy: { label: 'Inaccuracy', glyph: '?!' },
  mistake: { label: 'Mistake', glyph: '?' },
  blunder: { label: 'Blunder', glyph: '??' },
};

export const ERROR_CLASSES = ['inaccuracy', 'mistake', 'blunder'];

/** Converts an engine score, given for the side to move, to White's point of view. */
export function fromEngine(score, turn) {
  const sign = turn === 'w' ? 1 : -1;
  return score.mate === undefined ? { cp: score.cp * sign } : { mate: score.mate * sign };
}

/** White's expected score from 0 to 100, using the curve Lichess fitted to its games. */
export function winChance(evaluation) {
  if (evaluation.mate !== undefined) return evaluation.mate > 0 ? 100 : 0;
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * evaluation.cp)) - 1);
}

export function formatEval(evaluation) {
  if (evaluation.over) {
    if (evaluation.mate === undefined) return '½-½';
    return evaluation.mate > 0 ? '1-0' : '0-1';
  }
  if (evaluation.mate !== undefined) return `${evaluation.mate > 0 ? '+' : '-'}M${Math.abs(evaluation.mate)}`;
  const pawns = evaluation.cp / 100;
  return `${pawns > 0 ? '+' : ''}${pawns.toFixed(2)}`;
}

export function classify(loss) {
  const match = LOSS_LIMITS.find(([, limit]) => loss <= limit);
  return match ? match[0] : 'blunder';
}

/** A 0-100 score for one move, using the curve Lichess publishes for its accuracy figure. */
export function moveAccuracy(loss) {
  return Math.min(100, Math.max(0, 103.1668 * Math.exp(-0.04354 * loss) - 3.1669));
}

/** The evaluation of a finished position, which the engine has no move to search for. */
function finalEvaluation(chess) {
  if (chess.isCheckmate()) return { mate: chess.turn() === 'w' ? -1 : 1, over: true };
  return { cp: 0, over: true };
}

/**
 * Evaluates the position before each move and the one after the last.
 * `moves` are verbose chess.js moves. Returns null if `isCancelled` turns true.
 */
export async function analyseGame(engine, moves, { onProgress = () => {}, isCancelled = () => false } = {}) {
  if (!moves.length) return [];
  const fens = [...moves.map((move) => move.before), moves[moves.length - 1].after];
  const positions = [];
  for (const fen of fens) {
    if (isCancelled()) return null;
    const chess = new Chess(fen);
    if (chess.isGameOver()) {
      positions.push({ fen, evaluation: finalEvaluation(chess), best: null, pv: [] });
    } else {
      const { best, score, pv } = await engine.analyse(fen);
      positions.push({ fen, evaluation: fromEngine(score, chess.turn()), best, pv });
    }
    onProgress(positions.length, fens.length);
  }
  return isCancelled() ? null : positions;
}

/** Plays UCI moves from a position and returns them in SAN, stopping at anything illegal. */
function sanLine(fen, pv, length = LINE_LENGTH) {
  const chess = new Chess(fen);
  const moves = [];
  try {
    for (const uci of pv.slice(0, length)) {
      moves.push(chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san);
    }
  } catch {
    // An engine line that doesn't fit this position is cut short rather than shown wrong.
  }
  return moves;
}

/** Is this move common among strong players in this position? */
export function isBookMove(rows, san) {
  return rows.some((row) => row.san === san && row.share >= BOOK_MIN_SHARE);
}

/**
 * Turns the engine's evaluations into a graded game.
 * `isBook(fen, san)` says whether a move is opening theory. A game leaves theory once.
 */
export function buildReview(moves, positions, isBook = () => false) {
  let inBook = true;
  const plies = moves.map((move, index) => {
    const before = positions[index];
    const after = positions[index + 1];
    const sign = move.color === 'w' ? 1 : -1;
    const toMover = (chance) => (sign > 0 ? chance : 100 - chance);
    const chanceBefore = toMover(winChance(before.evaluation));
    const chanceAfter = toMover(winChance(after.evaluation));
    const onlyMove = new Chess(move.before).moves().length === 1;
    const isBest = onlyMove || move.lan === before.best;
    const loss = isBest ? 0 : Math.max(0, chanceBefore - chanceAfter);

    inBook = inBook && isBook(move.before, move.san);
    let grade = isBest ? 'best' : classify(loss);
    if (inBook && loss <= BOOK_MAX_LOSS) grade = 'book';

    const line = sanLine(move.before, before.pv);
    return {
      number: Math.floor(index / 2) + 1,
      color: move.color,
      san: move.san,
      from: move.from,
      to: move.to,
      fenBefore: move.before,
      fenAfter: move.after,
      evaluation: after.evaluation,
      grade,
      loss,
      chanceBefore,
      chanceAfter,
      isBest,
      best: before.best && !isBest
        ? { san: line[0], from: before.best.slice(0, 2), to: before.best.slice(2, 4) }
        : null,
      line,
      lineUci: before.pv.slice(0, LINE_LENGTH),
    };
  });

  const summarise = (color) => {
    const own = plies.filter((ply) => ply.color === color);
    const counts = Object.fromEntries(Object.keys(CLASSES).map((grade) => [grade, 0]));
    for (const ply of own) counts[ply.grade] += 1;
    const accuracy = own.length
      ? own.reduce((sum, ply) => sum + moveAccuracy(ply.loss), 0) / own.length
      : null;
    return { accuracy, counts };
  };

  return { start: positions[0], plies, players: { w: summarise('w'), b: summarise('b') } };
}
