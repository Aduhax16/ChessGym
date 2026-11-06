// Loads the static data files. Everything is relative to this module so the
// site works from any sub-path (for example https://user.github.io/repo/).

const cache = new Map();

async function loadJson(path) {
  if (!cache.has(path)) {
    const url = new URL(`../data/${path}`, import.meta.url);
    cache.set(
      path,
      fetch(url).then((response) => {
        if (!response.ok) throw new Error(`Could not load ${path} (${response.status})`);
        return response.json();
      }),
    );
  }
  return cache.get(path);
}

export const loadOpenings = () => loadJson('openings.json');
export const loadMeta = () => loadJson('book/meta.json');
export const loadBand = (id) => loadJson(`book/${id}.json`);

/** Placement, side to move and castling. Must match position_key() in scripts/build_book.py. */
export function keyOf(fen) {
  return fen.split(' ').slice(0, 3).join(' ');
}

/**
 * Moves played in a position, most popular first.
 * Each row of the data file is [san, games, whiteWins, draws, blackWins].
 */
export function rowsFor(book, fen) {
  const rows = book?.[keyOf(fen)];
  if (!rows) return [];
  const total = rows.reduce((sum, row) => sum + row[1], 0);
  return rows.map(([san, games, white, draws, black]) => ({
    san,
    games,
    share: games / total,
    white: white / games,
    draws: draws / games,
    black: black / games,
  }));
}

/**
 * What a player between two levels plays: the bands' move shares, averaged by
 * `mix` ([{ id, weight }]). A band with no data for the position is left out
 * and the remaining weights are rescaled.
 */
export function blendRows(books, mix, fen) {
  const sources = mix
    .map(({ id, weight }) => ({ weight, rows: rowsFor(books[id], fen) }))
    .filter((source) => source.rows.length && source.weight > 0);
  const totalWeight = sources.reduce((sum, source) => sum + source.weight, 0);
  const merged = new Map();
  for (const { weight, rows } of sources) {
    const scale = weight / totalWeight;
    for (const row of rows) {
      const entry = merged.get(row.san) ?? { san: row.san, games: 0, share: 0, white: 0, draws: 0, black: 0 };
      entry.games += row.games;
      entry.share += row.share * scale;
      entry.white += row.white * row.share * scale;
      entry.draws += row.draws * row.share * scale;
      entry.black += row.black * row.share * scale;
      merged.set(row.san, entry);
    }
  }
  return [...merged.values()]
    .map((row) => ({
      ...row,
      white: row.white / row.share,
      draws: row.draws / row.share,
      black: row.black / row.share,
    }))
    .sort((a, b) => b.share - a.share);
}
