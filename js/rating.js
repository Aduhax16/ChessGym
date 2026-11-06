// Turns "I am 1300 on Chess.com" into a pool of opponents.
//
// The game data uses Lichess ratings, so everything converts to that scale.
// There is no official conversion between rating systems. These offsets follow
// the commonly quoted rules of thumb and are only rough estimates, which is why
// the interface always lets people move their opponents up or down a level.

export const SCALES = [
  { id: 'chesscom', label: 'Chess.com', points: [[0, 200], [1800, 200], [2600, 50], [4000, 50]] },
  { id: 'lichess', label: 'Lichess', points: [[0, 0], [4000, 0]] },
  { id: 'fide', label: 'FIDE / OTB', points: [[0, 350], [1600, 350], [2500, 100], [4000, 100]] },
];

export const LEVELS = [
  { id: 'easier', label: 'Easier', hint: 'One level down', low: -250, high: -250 },
  { id: 'same', label: 'My level', hint: 'Your rating band', low: 0, high: 0 },
  { id: 'harder', label: 'Harder', hint: 'One level up', low: 250, high: 250 },
  { id: 'mixed', label: 'Mixed', hint: 'Below, equal and above', low: -250, high: 250 },
];

const STEP = 250;
const MIN_ELO = 500;
const MAX_ELO = 2750;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function offsetAt(points, rating) {
  for (let index = 1; index < points.length; index += 1) {
    const [x1, y1] = points[index - 1];
    const [x2, y2] = points[index];
    if (rating <= x2) return y1 + ((rating - x1) / (x2 - x1)) * (y2 - y1);
  }
  return points[points.length - 1][1];
}

const scaleOf = (id) => SCALES.find((scale) => scale.id === id) ?? SCALES[0];

export function toLichess(rating, scaleId) {
  return rating + offsetAt(scaleOf(scaleId).points, rating);
}

export function fromLichess(rating, scaleId) {
  // The offset changes slowly, so a few iterations are plenty.
  let estimate = rating;
  for (let step = 0; step < 8; step += 1) {
    estimate = rating - offsetAt(scaleOf(scaleId).points, estimate);
  }
  return estimate;
}

/** The player's 250-point band, shifted by the chosen level. In Lichess Elo. */
export function opponentRange(rating, scaleId, levelId) {
  const level = LEVELS.find((item) => item.id === levelId) ?? LEVELS[1];
  const lichess = toLichess(rating, scaleId);
  const low = Math.floor(lichess / STEP) * STEP;
  const from = clamp(low + level.low, MIN_ELO, MAX_ELO - STEP);
  const to = clamp(low + STEP + level.high, from + STEP, MAX_ELO);
  return { low: from, high: to };
}

/** The open-ended bands at each end count as ordinary 250-point bands. */
const centerOf = (band) => (band.low === 0 ? band.high - STEP / 2 : band.low + STEP / 2);

/**
 * Blend of the two bands nearest to `rating`: 1375 is purely the 1250-1500
 * band, and 1500 is half of it and half of the band above.
 */
export function mixFor(rating, bands) {
  const sorted = [...bands].sort((a, b) => a.low - b.low);
  if (rating <= centerOf(sorted[0])) return [{ id: sorted[0].id, weight: 1 }];
  for (let index = 1; index < sorted.length; index += 1) {
    const upper = centerOf(sorted[index]);
    if (rating <= upper) {
      const lower = centerOf(sorted[index - 1]);
      const weight = (rating - lower) / (upper - lower);
      return [
        { id: sorted[index - 1].id, weight: 1 - weight },
        { id: sorted[index].id, weight },
      ].filter((item) => item.weight > 0);
    }
  }
  return [{ id: sorted[sorted.length - 1].id, weight: 1 }];
}

/** Draws one opponent. A new one is drawn for each game. */
export function drawOpponent(range, bands, random = Math.random) {
  const rating = Math.round(range.low + random() * (range.high - range.low));
  return { rating, mix: mixFor(rating, bands) };
}

/** Every band any opponent in the range could draw on. */
export function bandsInRange(range, bands) {
  const ids = new Set();
  for (let rating = range.low; rating <= range.high; rating += STEP / 2) {
    for (const { id } of mixFor(rating, bands)) ids.add(id);
  }
  return [...ids];
}
