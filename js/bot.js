// A small bot for free play, used once a game leaves the real-game data.
// It looks one or two moves ahead and adds rating-based noise to its judgement.
// It imitates human errors only loosely and tops out at club strength: it is a
// way to finish a game, not a calibrated opponent.

const VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
const CENTER = [0, 1, 2, 3, 3, 2, 1, 0];
const MATE = 100_000;

function evaluate(chess, color) {
  let score = 0;
  chess.board().forEach((row, rank) => row.forEach((piece, file) => {
    if (!piece) return;
    const centrality = piece.type === 'k' ? 0 : (CENTER[file] + CENTER[rank]) * 3;
    const value = VALUES[piece.type] + centrality;
    score += piece.color === color ? value : -value;
  }));
  return score;
}

function search(chess, color, depth) {
  if (chess.isCheckmate()) return chess.turn() === color ? -MATE : MATE;
  if (chess.isDraw()) return 0;
  if (depth === 0) return evaluate(chess, color);
  const maximizing = chess.turn() === color;
  let best = maximizing ? -Infinity : Infinity;
  for (const move of chess.moves()) {
    chess.move(move);
    const score = search(chess, color, depth - 1);
    chess.undo();
    best = maximizing ? Math.max(best, score) : Math.min(best, score);
  }
  return best;
}

/** Stronger ratings look further and blunder less. */
export function botSettings(rating) {
  return {
    depth: rating < 900 ? 0 : 1,
    noise: Math.min(220, Math.max(15, (2200 - rating) / 6)),
  };
}

/** Picks a move in SAN for the side to move in `chess`. */
export function botMove(chess, rating, random = Math.random) {
  const color = chess.turn();
  const { depth, noise } = botSettings(rating);
  let bestMove = null;
  let bestScore = -Infinity;
  for (const move of chess.moves()) {
    chess.move(move);
    const score = search(chess, color, depth) + (random() - 0.5) * 2 * noise;
    chess.undo();
    if (score > bestScore) {
      bestScore = score;
      bestMove = move;
    }
  }
  return bestMove;
}
