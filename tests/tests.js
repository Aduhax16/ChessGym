// Browser tests for the training logic: serve the repo and open /tests/.
import { Chess } from '../vendor/chess.js';
import { blendRows, keyOf, loadBand, loadMeta, loadOpenings, rowsFor } from '../js/book.js';
import { bandsByDistance, bandsInRange, drawOpponent, fromLichess, mixFor, opponentRange, toLichess } from '../js/rating.js';
import { buildIndex, MODES, Trainer, userPositions } from '../js/trainer.js';
import { materialFromFen } from '../js/material.js';
import { Progress } from '../js/progress.js';
import { botMove, chooseMove, Engine, ENGINE_CEILING, ENGINE_FLOOR, engineSettings, parseInfo } from '../js/bot.js';
import { analyseGame, buildReview, classify, formatEval, fromEngine, isBookMove, moveAccuracy, winChance } from '../js/review.js';

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

test('engine settings follow the rating and stay inside the engine limits', () => {
  equal(engineSettings(1800), { elo: 1800, slipChance: 0 });
  equal(engineSettings(ENGINE_FLOOR), { elo: ENGINE_FLOOR, slipChance: 0 });
  equal(engineSettings(9000).elo, ENGINE_CEILING);
  equal(engineSettings(600).elo, ENGINE_FLOOR);
});

test('opponents below the floor slip more the weaker they are', () => {
  const slips = [1300, 1100, 900, 700, 500].map((rating) => engineSettings(rating).slipChance);
  slips.forEach((slip, index) => assert(index === 0 || slip > slips[index - 1], `not rising: ${slips}`));
  assert(slips[0] > 0, 'just below the floor should already slip sometimes');
  assert(slips[4] < 1, 'the weakest opponent should still use the engine sometimes');
});

const fakeEngine = (answer) => ({
  failed: false,
  asked: [],
  async bestMove(chess, elo) {
    this.asked.push(elo);
    return answer(chess);
  },
});
const MATE_IN_ONE = '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1';

test('without an engine the small bot plays', async () => {
  const { san, source } = await chooseMove(new Chess(MATE_IN_ONE), 2200, null, () => 0.5);
  equal([san, source], ['Rd8#', 'bot']);
});

test('the engine chooses at the opponent\'s rating, and promotions convert to SAN', async () => {
  const engine = fakeEngine(() => 'a7a8q');
  const { san, source } = await chooseMove(new Chess('6k1/P7/8/8/8/8/8/6K1 w - - 0 1'), 1800, engine);
  equal([san, source], ['a8=Q+', 'engine']);
  equal(engine.asked, [1800]);
});

test('the small bot steps in if the engine fails or answers nonsense', async () => {
  const failing = fakeEngine(() => { throw new Error('no engine'); });
  equal((await chooseMove(new Chess(MATE_IN_ONE), 1800, failing, () => 0.5)).source, 'bot');
  const illegal = fakeEngine(() => 'a1a8');
  const chess = new Chess(MATE_IN_ONE);
  const before = chess.fen();
  const { san, source } = await chooseMove(chess, 1800, illegal, () => 0.5);
  equal(source, 'bot');
  assert(chess.moves().includes(san), `${san} is not legal`);
  equal(chess.fen(), before);
});

test('a slip below the floor skips the engine', async () => {
  const engine = fakeEngine(() => 'd1d8');
  equal((await chooseMove(new Chess(MATE_IN_ONE), 800, engine, () => 0)).source, 'slip');
  equal(engine.asked, []);
  equal((await chooseMove(new Chess(MATE_IN_ONE), 800, engine, () => 0.99)).source, 'engine');
  equal(engine.asked, [ENGINE_FLOOR]);
});

test('free play asks the engine only once the real games run out', async () => {
  const engine = fakeEngine((chess) => { const move = chess.moves({ verbose: true })[0]; return move.from + move.to; });
  const strong = { rating: 1800, mix: onlyLow.mix };
  const trainer = make({ opening: freeOpening, free: true, engine, opponent: strong });
  trainer.tryMove('e4');
  const real = await trainer.playRivalWithEngine();
  equal([real.san, Boolean(real.bot), engine.asked], ['e5', false, []]);
  trainer.tryMove('a3');
  const fromEngine = await trainer.playRivalWithEngine();
  equal([fromEngine.bot, fromEngine.source, engine.asked], [true, 'engine', [1800]]);
  equal(trainer.history.length, 4);
});

const workerFrom = (code) => URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
const FAST = { thinkMs: 20 };

test('creating an engine downloads nothing until it is needed', () => {
  equal(new Engine().worker, null);
});

test('real engine: it loads and mates at full strength', async () => {
  const engine = new Engine(FAST);
  try {
    await engine.load();
    const { san, source } = await chooseMove(new Chess(MATE_IN_ONE), ENGINE_CEILING, engine);
    equal([san, source], ['Rd8#', 'engine']);
  } finally {
    engine.terminate();
  }
});

test('real engine: it answers with the game history and at the floor', async () => {
  const engine = new Engine(FAST);
  try {
    const chess = new Chess();
    for (const san of ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'e4', 'e5']) chess.move(san);
    const { san, source } = await chooseMove(chess, ENGINE_FLOOR, engine, () => 0.5);
    equal(source, 'engine');
    assert(chess.moves().includes(san), `${san} is not legal`);
    assert(!engine.failed, 'the engine should still be healthy');
  } finally {
    engine.terminate();
  }
});

test('real engine: a whole free game ends in checkmate', async () => {
  const engine = new Engine(FAST);
  try {
    const trainer = new Trainer({ opening: freeOpening, free: true, opponent: { rating: 2700, mix: onlyLow.mix }, books, engine });
    while (!trainer.done && trainer.ply < 400) {
      if (trainer.isUserTurn) trainer.tryMove(trainer.chess.moves()[0]);
      else equal((await trainer.playRivalWithEngine()).source, 'engine');
    }
    assert(trainer.chess.isCheckmate(), `expected mate, got ${trainer.fen}`);
    equal(trainer.chess.turn(), 'w');
  } finally {
    engine.terminate();
  }
});

test('a missing engine file falls back to the bot', async () => {
  const engine = new Engine({ url: '/vendor/stockfish/does-not-exist.js', loadTimeout: 3000 });
  const { source } = await chooseMove(new Chess(MATE_IN_ONE), 1800, engine, () => 0.5);
  equal(source, 'bot');
  equal(engine.failed, true);
  equal((await chooseMove(new Chess(MATE_IN_ONE), 1800, engine, () => 0.5)).source, 'bot');
});

test('a missing engine binary falls back to the bot', async () => {
  const url = new URL('../vendor/stockfish/stockfish-19-lite-single.js#/vendor/stockfish/does-not-exist.wasm', import.meta.url);
  const engine = new Engine({ url, loadTimeout: 500 });
  equal((await chooseMove(new Chess(MATE_IN_ONE), 1800, engine, () => 0.5)).source, 'bot');
  equal(engine.failed, true);
});

test('a slow download doesn\'t hold up the game, and isn\'t given up on', async () => {
  const engine = new Engine({ url: workerFrom(''), loadWait: 50, loadTimeout: 60000 });
  try {
    equal((await chooseMove(new Chess(MATE_IN_ONE), 1800, engine, () => 0.5)).source, 'bot');
    equal(engine.failed, false);
    equal(engine.loadWait, 0); // later moves don't wait again
  } finally {
    engine.terminate();
  }
});

test('a search that hangs falls back to the bot and stops using the engine', async () => {
  const url = workerFrom("onmessage = (event) => { if (event.data === 'uci') postMessage('uciok'); };");
  const engine = new Engine({ url, moveTimeout: 100 });
  equal((await chooseMove(new Chess(MATE_IN_ONE), 1800, engine, () => 0.5)).source, 'bot');
  equal(engine.failed, true);
  equal(engine.worker, null);
});

test('stopping the engine mid-search still gives a move', async () => {
  const url = workerFrom("onmessage = (event) => { if (event.data === 'uci') postMessage('uciok'); };");
  const engine = new Engine({ url });
  await engine.load();
  const move = chooseMove(new Chess(MATE_IN_ONE), 1800, engine, () => 0.5);
  await new Promise((resolve) => { setTimeout(resolve, 50); });
  engine.terminate();
  equal((await move).source, 'bot');
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


/* ---------- Material ---------- */

test('the starting position has no captures and no lead', () => {
  equal(materialFromFen(new Chess().fen()), { captured: { w: [], b: [] }, advantage: 0 });
});

test('captures are listed for the side that made them, weakest first', () => {
  const chess = new Chess();
  for (const san of ['e4', 'd5', 'exd5', 'Qxd5', 'Nc3', 'Qxg2', 'Bxg2']) chess.move(san);
  const { captured, advantage } = materialFromFen(chess.fen());
  equal(captured.w, ['p', 'q']);
  equal(captured.b, ['p', 'p']);
  equal(advantage, 8);
});

test('the lead is negative when Black is ahead', () => {
  equal(materialFromFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNB1KBNR w KQkq - 0 1').advantage, -9);
});

test('a promoted pawn counts as the new piece and not as a capture', () => {
  const { captured, advantage } = materialFromFen('Qnbqkbnr/1ppppppp/8/8/8/8/1PPPPPPP/RNBQKBNR b KQk - 0 1');
  equal(captured.b, []);
  equal(captured.w, ['p', 'r']);
  equal(advantage, 14);
});

/* ---------- Game review ---------- */

function playedMoves(...sans) {
  const chess = new Chess();
  return sans.map((san) => chess.move(san));
}

/** Answers from a table keyed by position, with the search's score for the side to move. */
const fakeAnalyst = (answers) => ({
  asked: [],
  async analyse(fen) {
    this.asked.push(fen);
    return answers[fen];
  },
});

test('expected score is even at 0, follows the evaluation and is certain at mate', () => {
  equal(winChance({ cp: 0 }), 50);
  assert(winChance({ cp: 300 }) > winChance({ cp: 100 }));
  assert(Math.abs(winChance({ cp: 200 }) + winChance({ cp: -200 }) - 100) < 1e-9);
  equal([winChance({ mate: 3 }), winChance({ mate: -3 })], [100, 0]);
});

test('engine scores become White\'s point of view', () => {
  equal(fromEngine({ cp: 40 }, 'w'), { cp: 40 });
  equal(fromEngine({ cp: 40 }, 'b'), { cp: -40 });
  equal(fromEngine({ mate: 2 }, 'b'), { mate: -2 });
});

test('moves are graded by how much expected score they give away', () => {
  equal([0, 2, 2.1, 5, 5.1, 10, 10.1, 20, 20.1].map(classify),
    ['excellent', 'excellent', 'good', 'good', 'inaccuracy', 'inaccuracy', 'mistake', 'mistake', 'blunder']);
  assert(moveAccuracy(0) > 99.9, 'a perfect move should score about 100');
  assert(moveAccuracy(50) < moveAccuracy(5), 'worse moves should score lower');
  assert(moveAccuracy(100) >= 0);
});

test('evaluations read like a chess site', () => {
  equal([{ cp: 35 }, { cp: -120 }, { cp: 0 }, { mate: 3 }, { mate: -2 }].map((evaluation) => formatEval(evaluation)),
    ['+0.35', '-1.20', '0.00', '+M3', '-M2']);
  equal(formatEval({ cp: -2450 }, 1), '-24.5');
  equal([{ mate: 1, over: true }, { mate: -1, over: true }, { cp: 0, over: true }].map((evaluation) => formatEval(evaluation)), ['1-0', '0-1', '½-½']);
});

test('UCI info lines give a score and line, and bounds are ignored', () => {
  equal(parseInfo('info depth 12 seldepth 18 multipv 1 score cp -23 nodes 9 nps 9 time 1 pv e7e5 g1f3'), { score: { cp: -23 }, pv: ['e7e5', 'g1f3'] });
  equal(parseInfo('info depth 3 score mate 2 nodes 9 pv d1h5'), { score: { mate: 2 }, pv: ['d1h5'] });
  equal(parseInfo('info depth 12 score cp 15 lowerbound nodes 9 pv e2e4'), null);
  equal(parseInfo('info string NNUE evaluation using nn.nnue'), null);
});

test('a review asks about every position and skips finished ones', async () => {
  const moves = playedMoves('f3', 'e5', 'g4', 'Qh4#');
  const answers = {};
  for (const move of moves) answers[move.before] = { best: move.lan, score: { cp: 0 }, pv: [move.lan] };
  const engine = fakeAnalyst(answers);
  const seen = [];
  const positions = await analyseGame(engine, moves, { onProgress: (done, total) => seen.push([done, total]) });
  equal(engine.asked.length, 4);
  equal(positions.length, 5);
  equal(positions[4].evaluation, { mate: -1, over: true });
  equal(seen[4], [5, 5]);
});

test('a review stops when the game is abandoned', async () => {
  const moves = playedMoves('e4');
  const engine = fakeAnalyst({});
  equal(await analyseGame(engine, moves, { isCancelled: () => true }), null);
  equal(engine.asked, []);
});

test('the review grades both players and names the better move', () => {
  const moves = playedMoves('e4', 'e5', 'Qh5', 'Nf6');
  const position = (cp, best, turn, pv = [best]) => ({ fen: '', evaluation: { cp }, best, pv, turn });
  const positions = [
    position(30, 'e2e4'),
    position(30, 'e7e5'),
    position(30, 'g1f3'),
    position(-150, 'b8c6', 'b', ['b8c6', 'f1c4']),
    { evaluation: { cp: 900 }, best: 'h5f7', pv: ['h5f7'] },
  ];
  const review = buildReview(moves, positions);
  equal(review.plies.map((ply) => ply.grade), ['best', 'best', 'mistake', 'blunder']);
  equal(review.plies[2].best, { san: 'Nf3', from: 'g1', to: 'f3' });
  equal(review.plies[0].best, null);
  equal(review.plies[3].best, { san: 'Nc6', from: 'b8', to: 'c6' });
  equal(review.plies[3].line, ['Nc6', 'Bc4']);
  equal([review.players.w.counts.mistake, review.players.b.counts.blunder], [1, 1]);
  assert(review.players.w.accuracy > review.players.b.accuracy, 'the bigger error should cost more accuracy');
  assert(review.plies[3].chanceBefore > review.plies[3].chanceAfter, 'chances are from the mover\'s side');
});

test('opening theory is marked until the game leaves it for good', () => {
  const moves = playedMoves('e4', 'e5', 'Nf3');
  const evaluation = { evaluation: { cp: 20 }, best: 'a2a3', pv: ['a2a3'] };
  const book = new Set(['e4', 'e5', 'Nf3']);
  const positions = [evaluation, evaluation, evaluation, evaluation];
  equal(buildReview(moves, positions, (_, san) => book.has(san)).plies.map((ply) => ply.grade), ['book', 'book', 'book']);
  book.delete('e5');
  equal(buildReview(moves, positions, (_, san) => book.has(san)).plies.map((ply) => ply.grade), ['book', 'excellent', 'excellent']);
  assert(isBookMove([{ san: 'e4', share: 0.5 }], 'e4'));
  assert(!isBookMove([{ san: 'e4', share: 0.01 }], 'e4'), 'a rare move is not theory');
});

test('the only legal move is never a mistake', () => {
  const chess = new Chess('7k/8/8/8/8/8/6q1/7K w - - 0 1');
  const moves = chess.moves({ verbose: true }).slice(0, 1);
  equal(moves.length, 1);
  const review = buildReview(moves, [
    { evaluation: { cp: 0 }, best: 'a1a2', pv: [] },
    { evaluation: { mate: -3 }, best: null, pv: [] },
  ]);
  equal([review.plies[0].grade, review.plies[0].loss], ['best', 0]);
});

test('resigning ends only a free game', () => {
  const trainer = make({ opening: freeOpening, free: true });
  trainer.resign();
  equal([trainer.done, trainer.endReason], [true, 'resigned']);
  const drill = make();
  drill.resign();
  equal(drill.done, false);
});

test('real Stockfish finds a mate at full strength', async () => {
  const engine = new Engine();
  try {
    const { best, score } = await engine.analyse(MATE_IN_ONE);
    equal(score, { mate: 1 });
    equal(best, 'd1d8');
  } finally {
    engine.terminate();
  }
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
