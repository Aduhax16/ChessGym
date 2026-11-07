// Who has captured what, and who is ahead in material. No DOM here.

const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const START = { p: 8, n: 2, b: 2, r: 2, q: 1 };
// Weakest first, the order the captured pieces are shown in.
const ORDER = ['p', 'n', 'b', 'r', 'q'];

function countPieces(fen) {
  const counts = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
  for (const char of fen.split(' ')[0]) {
    const type = char.toLowerCase();
    if (VALUES[type] === undefined) continue;
    counts[char === type ? 'b' : 'w'][type] += 1;
  }
  return counts;
}

/** The pieces a side has lost. A pawn that promoted wasn't lost, it became the extra piece. */
function lostPieces(own) {
  const promotions = ORDER.reduce((sum, type) => (type === 'p' ? sum : sum + Math.max(0, own[type] - START[type])), 0);
  const lost = [];
  for (const type of ORDER) {
    const missing = START[type] - own[type] - (type === 'p' ? promotions : 0);
    for (let index = 0; index < missing; index += 1) lost.push(type);
  }
  return lost;
}

/**
 * For a game from the normal start. `captured.w` holds the types White has taken,
 * and `advantage` is White's lead in points, negative when Black is ahead.
 */
export function materialFromFen(fen) {
  const counts = countPieces(fen);
  const points = (own) => ORDER.reduce((sum, type) => sum + own[type] * VALUES[type], 0);
  return {
    captured: { w: lostPieces(counts.b), b: lostPieces(counts.w) },
    advantage: points(counts.w) - points(counts.b),
  };
}
