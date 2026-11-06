// Browser tests for the training logic: serve the repo and open /tests/.
import { Chess } from '../vendor/chess.js';
import { blendRows, keyOf, loadBand, loadMeta, loadOpenings, rowsFor } from '../js/book.js';
import { bandsByDistance, bandsInRange, drawOpponent, fromLichess, mixFor, opponentRange, toLichess } from '../js/rating.js';
import { buildIndex, MODES, Trainer, userPositions } from '../js/trainer.js';
import { Progress } from '../js/progress.js';
import { botMove } from '../js/bot.js';

const results = [];
function test(name, fn) { results.push([name, fn]); }
function assert(condition, message) { if (!condition) throw new Error(message ?? 'assertion failed'); }
function equal(actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  assert(a === b, `expected ${b}, got ${a}`);
}

const START = keyOf(new Chess().fen());
const AFTER_E4 = keyOf(new Chess('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1').fen());

function fakeProgress() {
  const recorded = [];
  return {
    recorded,
    finished: [],
    record(id, key, firstTry) { recorded.push(firstTry); },
    level: () => 0,
    finish(id, clean) { this.finished.push(clean); },
  };
}

const opening = {
  id: 'test',
  color: 'white',
  prefix: 'e4',
  lines: [{ name: 'A', moves: 'e4 e5 Nf3 Nc6 Bc4', idea: '' }, { name: 'B', moves: 'e4 c5 Nf3', idea: '' }],
};
const books = {
  1000: { [AFTER_E4]: [['e5', 90, 40, 10, 40], ['c5', 10, 5, 1, 4]] },
  1250: { [AFTER_E4]: [['e5', 50, 20, 10, 20], ['c5', 50, 20, 10, 20]] },
  reference: {},
};
const onlyLow = { rating: 1125, mix: [{ id: '1000', weight: 1 }] };
const make = (extra = {}) => new Trainer({
  opening, opponent: onlyLow, books, progress: fakeProgress(), plies: 6, random: () => 0, ...extra,
});
const BANDS = [
  { id: 'u750', low: 0, high: 750 },
  { id: '750', low: 750, high: 1000 },
  { id: '1000', low: 1000, high: 1250 },
  { id: '1250', low: 1250, high: 1500 },
  { id: '1500', low: 1500, high: 1750 },
  { id: '2500', low: 2500, high: 9999 },
];

test('rowsFor computes shares', () => {
  const rows = rowsFor(books[1000], 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
  equal(rows[0].san, 'e5');
  equal(rows[0].share, 0.9);
});

test('keys ignore en passant and move counters', () => {
  equal(keyOf('8/8/8/8/8/8/8/K6k w - e3 4 9'), '8/8/8/8/8/8/8/K6k w -');
});

test('index separates user and rival moves', () => {
  const index = buildIndex(opening);
  equal([...index.get(START).user], ['e4']);
  equal([...index.get(AFTER_E4).rival], ['e5', 'c5']);
});

test('userPositions lists only positions where the user answers', () => {
  equal(userPositions(opening).length, 4);
});

test('wrong move is rejected and leaves the position untouched', () => {
  const trainer = make();
  const before = trainer.fen;
  const result = trainer.tryMove('d4');
  equal(result.ok, false);
  equal(trainer.fen, before);
  equal(trainer.mistakes, 1);
  trainer.tryMove('c4');
  equal(trainer.mistakes, 1);
});

test('a retried move is recorded as not known', () => {
  const progress = fakeProgress();
  const trainer = make({ progress });
  trainer.tryMove('d4');
  trainer.tryMove('e4');
  equal(progress.recorded, [false]);
});

test('learn mode does not touch progress', () => {
  const progress = fakeProgress();
  const trainer = make({ progress, mode: MODES.LEARN });
  trainer.tryMove('e4');
  equal(progress.recorded, []);
});

test('rival plays the first listed move when random is 0', () => {
  const trainer = make();
  trainer.tryMove('e4');
  equal(trainer.playRival().san, 'e5');
});

test('rival follows frequencies', () => {
  const trainer = make({ random: () => 0.95 });
  trainer.tryMove('e4');
  equal(trainer.playRival().san, 'c5');
});

test('adaptive mode boosts a line with no mastery', () => {
  const weights = (progress) => {
    const trainer = make({ progress });
    trainer.tryMove('e4');
    return Object.fromEntries(trainer.rivalCandidates().map((item) => [item.san, item.weight]));
  };
  const mastered = { ...fakeProgress(), level: () => 2 };
  equal(weights(mastered), { e5: 0.9, c5: 0.1 });
  assert(Math.abs(weights(fakeProgress()).e5 - 4.5) < 1e-9, 'unmastered lines count five times');
});

test('prefix moves are forced for the rival', () => {
  const black = { ...opening, color: 'black', prefix: 'e4 c6', lines: [{ name: 'X', moves: 'e4 c6 d4 d5', idea: '' }] };
  const trainer = make({ opening: black });
  equal(trainer.isUserTurn, false);
  equal(trainer.playRival().forced, true);
  equal(trainer.history, ['e4']);
  equal(trainer.expected().moves, ['c6']);
});

test('session ends when no reference exists and reports it', () => {
  const progress = fakeProgress();
  const trainer = make({ progress });
  trainer.tryMove('e4');
  trainer.playRival();
  trainer.tryMove('Nf3');
  // The book has nothing for this position, so the rival falls back to the written line.
  trainer.playRival();
  trainer.tryMove('Bc4');
  equal(trainer.done, true);
  equal(trainer.endReason, 'noData');
  equal(progress.finished, [true]);
});

test('reference rows drop rare moves', () => {
  const trainer = make({
    books: { ...books, reference: { [START]: [['e4', 80, 1, 1, 1], ['a3', 5, 1, 1, 1], ['d4', 15, 1, 1, 1]] } },
    opening: { ...opening, prefix: 'e4', lines: [{ name: 'A', moves: 'e4', idea: '' }] },
  });
  equal(trainer.referenceRows().map((row) => row.san), ['e4', 'd4']);
});

const emptyProgress = () => {
  const progress = new Progress();
  progress.data = { positions: {}, sessions: {}, settings: {} };
  progress._save = () => {};
  return progress;
};

test('a right answer counts straight away, and two master a position', () => {
  const progress = emptyProgress();
  progress.record('o', 'k', true);
  equal(progress.mastery('o', ['k']), 0.5);
  progress.record('o', 'k', true);
  equal(progress.mastery('o', ['k']), 1);
  progress.record('o', 'k', true);
  equal(progress.mastery('o', ['k']), 1);
});

test('a miss costs one level, not everything', () => {
  const progress = emptyProgress();
  progress.record('o', 'k', true);
  progress.record('o', 'k', true);
  progress.record('o', 'k', false);
  equal(progress.mastery('o', ['k']), 0.5);
  progress.record('o', 'k', false);
  progress.record('o', 'k', false);
  equal(progress.mastery('o', ['k']), 0);
});

test('mastery averages over all the positions', () => {
  const progress = emptyProgress();
  progress.record('o', 'a', true);
  progress.record('o', 'a', true);
  equal(progress.mastery('o', ['a', 'b']), 0.5);
});

test('a perfect first game shows progress', () => {
  const progress = emptyProgress();
  const trainer = make({ progress, plies: 3 });
  trainer.tryMove('e4');
  trainer.playRival();
  trainer.tryMove('Nf3');
  assert(progress.mastery('test', userPositions(opening)) > 0, 'expected more than 0%');
});

test('unmastered written lines can appear even without data', () => {
  const sparse = { ...books, 1000: { [AFTER_E4]: [['e5', 100, 40, 20, 40]] } };
  const trainer = make({ books: sparse });
  trainer.tryMove('e4');
  const names = trainer.rivalCandidates().map((item) => item.san);
  equal(names, ['e5', 'c5']);
  const settled = make({ books: sparse, progress: { ...fakeProgress(), level: () => 2 } });
  settled.tryMove('e4');
  equal(settled.rivalCandidates().map((item) => item.san), ['e5']);
});

const freeOpening = { id: 'free', name: 'Free play', color: 'white', prefix: '', lines: [] };

test('free play accepts any legal move and records nothing', () => {
  const progress = fakeProgress();
  const trainer = make({ opening: freeOpening, free: true, progress });
  equal(trainer.tryMove('a3').ok, true);
  equal(progress.recorded, []);
  equal(trainer.isUserTurn, false);
});

test('free play uses real moves first, then the bot', () => {
  const trainer = make({ opening: freeOpening, free: true });
  trainer.tryMove('e4');
  const real = trainer.playRival();
  equal(real.san, 'e5');
  equal(Boolean(real.bot), false);
  trainer.tryMove('a3');
  const bot = trainer.playRival();
  equal(bot.bot, true);
  equal(trainer.history.length, 4);
  equal(trainer.done, false);
});

test('free play runs until the game really ends', () => {
  const trainer = new Trainer({ opening: freeOpening, free: true, opponent: onlyLow, books, plies: 4 });
  let guard = 0;
  while (!trainer.done && guard < 400) {
    if (trainer.isUserTurn) trainer.tryMove(trainer.chess.moves()[0]);
    else trainer.playRival();
    guard += 1;
  }
  assert(trainer.ply > 4, 'plies should not limit free play');
  equal(trainer.endReason, 'gameOver');
});

test('free play borrows from nearby levels before using the bot', () => {
  const trainer = make({
    opening: freeOpening,
    free: true,
    opponent: { rating: 1125, mix: [{ id: 'empty', weight: 1 }] },
    nearbyBands: ['empty', '1250'],
    books: { ...books, empty: {} },
  });
  trainer.tryMove('e4');
  const played = trainer.playRival();
  equal(Boolean(played.bot), false);
  equal(played.san, 'e5');
});

test('bands are ordered by distance from the rating', () => {
  equal(bandsByDistance(1400, BANDS).slice(0, 2), ['1250', '1500']);
});

test('the bot mates in one and grabs a free queen', () => {
  const mate = new Chess('6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1');
  equal(botMove(mate, 2200, () => 0.5), 'Rd8#');
  const queen = new Chess('6k1/5ppp/8/3q4/4P3/8/5PPP/6K1 w - - 0 1');
  equal(botMove(queen, 2200, () => 0.5), 'exd5');
});

test('weak bots make more mistakes than strong ones', () => {
  const missed = (rating) => {
    let count = 0;
    const position = new Chess('6k1/5ppp/8/3p4/4P3/8/5PPP/6K1 w - - 0 1');
    for (let run = 0; run < 200; run += 1) if (botMove(position, rating) !== 'exd5') count += 1;
    return count;
  };
  assert(missed(600) > missed(2200), 'lower ratings should miss the capture more often');
});

test('a 1300 Lichess player gets the 1250-1500 band', () => {
  equal(opponentRange(1300, 'lichess', 'same'), { low: 1250, high: 1500 });
  equal(opponentRange(1300, 'lichess', 'easier'), { low: 1000, high: 1250 });
  equal(opponentRange(1300, 'lichess', 'harder'), { low: 1500, high: 1750 });
  equal(opponentRange(1300, 'lichess', 'mixed'), { low: 1000, high: 1750 });
});

test('Chess.com ratings convert up, and the conversion round-trips', () => {
  equal(toLichess(1100, 'chesscom'), 1300);
  equal(opponentRange(1100, 'chesscom', 'same'), { low: 1250, high: 1500 });
  assert(Math.abs(fromLichess(toLichess(2300, 'fide'), 'fide') - 2300) < 1, 'FIDE round trip');
});

test('extreme ratings stay inside the data', () => {
  equal(opponentRange(200, 'lichess', 'easier'), { low: 500, high: 750 });
  equal(opponentRange(3400, 'lichess', 'harder'), { low: 2500, high: 2750 });
});

test('opponents between band centres blend the two nearest bands', () => {
  equal(mixFor(1375, BANDS), [{ id: '1250', weight: 1 }]);
  equal(mixFor(1500, BANDS), [{ id: '1250', weight: 0.5 }, { id: '1500', weight: 0.5 }]);
  equal(mixFor(100, BANDS)[0].id, 'u750');
  equal(mixFor(3000, BANDS)[0].id, '2500');
  equal(mixFor(2625, BANDS), [{ id: '2500', weight: 1 }]);
  equal(mixFor(625, BANDS), [{ id: 'u750', weight: 1 }]);
});

test('blending averages the move shares', () => {
  const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
  const rows = blendRows(books, [{ id: '1000', weight: 0.5 }, { id: '1250', weight: 0.5 }], fen);
  equal(rows.map((row) => row.san), ['e5', 'c5']);
  assert(Math.abs(rows[0].share - 0.7) < 1e-9, 'e5 is (90% + 50%) / 2');
  assert(Math.abs(rows[0].white + rows[0].draws + rows[0].black - 1) < 1e-9, 'results add up');
});

test('blending ignores a band with no data for the position', () => {
  const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
  const rows = blendRows(books, [{ id: '1000', weight: 0.5 }, { id: 'missing', weight: 0.5 }], fen);
  equal(rows[0].share, 0.9);
});

test('drawn opponents stay inside the range', () => {
  const range = { low: 1250, high: 1500 };
  equal(drawOpponent(range, BANDS, () => 0).rating, 1250);
  equal(drawOpponent(range, BANDS, () => 0.999).rating, 1500);
});

test('every band an opponent can use gets loaded', () => {
  const ids = bandsInRange({ low: 1250, high: 1500 }, BANDS);
  ['1000', '1250', '1500'].forEach((id) => assert(ids.includes(id), `${id} is missing`));
});

const realData = async () => {
  const [data, meta] = await Promise.all([loadOpenings(), loadMeta()]);
  const loaded = { reference: await loadBand('reference') };
  for (const band of meta.bands) loaded[band.id] = await loadBand(band.id);
  return { data, meta, loaded };
};

test('real data: every opening survives sessions at every level', async () => {
  const { data, meta, loaded } = await realData();
  for (const candidate of data.openings) {
    for (const band of meta.bands) {
      for (let run = 0; run < 6; run += 1) {
        const opponent = drawOpponent({ low: Math.max(band.low, 500), high: Math.min(band.high, 2750) }, meta.bands);
        const trainer = new Trainer({ opening: candidate, opponent, books: loaded, plies: 24 });
        while (!trainer.done) {
          if (trainer.isUserTurn) {
            const { moves } = trainer.expected();
            assert(trainer.tryMove(moves[0]).ok, `${candidate.id}: ${moves[0]} was refused`);
          } else {
            trainer.playRival();
          }
        }
        assert(trainer.ply >= trainer.prefix.length, `${candidate.id}: ended inside the prefix`);
      }
    }
  }
});

test('real data: levels really differ', async () => {
  const { meta, loaded } = await realData();
  const fen = new Chess().fen();
  const low = meta.bands[0].id;
  const high = meta.bands[meta.bands.length - 1].id;
  const share = (id, san) => rowsFor(loaded[id], fen).find((row) => row.san === san)?.share ?? 0;
  assert(share(low, 'e4') > share(high, 'e4'), '1.e4 should be more popular among beginners');
  assert(share(low, 'Nf3') < share(high, 'Nf3'), '1.Nf3 should be more popular among strong players');
});

const list = document.getElementById('results');
let failed = 0;
for (const [name, fn] of results) {
  const item = document.createElement('li');
  try {
    await fn();
    item.className = 'pass';
    item.textContent = `✓ ${name}`;
  } catch (error) {
    failed += 1;
    item.className = 'fail';
    item.textContent = `✗ ${name}: ${error.message}`;
  }
  list.append(item);
}
document.getElementById('summary').textContent =
  `${results.length - failed}/${results.length} tests passed`;
document.documentElement.dataset.failed = String(failed);
