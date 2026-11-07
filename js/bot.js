// Free play's opponent once a game leaves the real-game data: Stockfish, limited
// by strength to the opponent's rating and running in its own Web Worker.
//
// The small bot below stands in if the engine can't load, and also supplies the
// extra mistakes that opponents below the engine's strength floor make. It looks
// one or two moves ahead with rating-based noise in its judgement, so it is a way
// to finish a game rather than a calibrated opponent.
//
// Stockfish is GPL-3 and stays a separate program: this file only exchanges UCI
// text with it. See vendor/stockfish/README.md.

const ENGINE_URL = new URL('../vendor/stockfish/stockfish-19-lite-single.js', import.meta.url);
// The UCI_Elo limits, hard-coded in Stockfish.
export const ENGINE_FLOOR = 1320;
export const ENGINE_CEILING = 3190;
// With a strength limit, Stockfish settles on its move at a shallow depth, reached
// well inside this time even on a phone, so this paces the game rather than sets strength.
const THINK_MS = 300;
const MOVE_TIMEOUT = 8000;
const LOAD_TIMEOUT = 60000;
// How long a move waits for an engine that is still downloading before the bot plays it.
const LOAD_WAIT = 3000;
// Below the floor, the rating gap at which every move would be left to the small bot.
// Fitted to matches against the engine at its floor; it is a rough fit.
const SLIP_SPAN = 1400;
// A slip always uses the bot at its weakest, where it doesn't look ahead. Its stronger
// setting makes such mild mistakes that a "1000" played far above its rating.
const SLIP_RATING = 800;

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

/**
 * The engine's Elo limit for an opponent, and how often that opponent slips.
 * Stockfish can't play below its floor, so weaker opponents play it at the floor
 * and hand a share of their moves to the small bot, which is what weakens them.
 */
export function engineSettings(rating) {
  return {
    elo: Math.min(ENGINE_CEILING, Math.max(ENGINE_FLOOR, Math.round(rating))),
    slipChance: Math.min(1, Math.max(0, (ENGINE_FLOOR - rating) / SLIP_SPAN)),
  };
}

/** A UCI move such as e7e8q as SAN, or an exception if it isn't legal here. */
function sanFromUci(chess, uci) {
  const move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  chess.undo();
  return move.san;
}

/** UCI position command for a game, with its moves so the engine can see repetitions. */
function positionCommand(chess) {
  const moves = chess.history({ verbose: true });
  const start = moves[0]?.before ?? chess.fen();
  return `position fen ${start}${moves.length ? ` moves ${moves.map((move) => move.lan).join(' ')}` : ''}`;
}

/** Talks UCI to Stockfish in a Web Worker. Nothing is downloaded until load(). */
export class Engine {
  constructor({ url = ENGINE_URL, thinkMs = THINK_MS, loadTimeout = LOAD_TIMEOUT, loadWait = LOAD_WAIT, moveTimeout = MOVE_TIMEOUT } = {}) {
    Object.assign(this, { url, thinkMs, loadTimeout, loadWait, moveTimeout });
    this.failed = false;
    this.worker = null;
    this.loading = null;
    this.waiting = null; // { pattern, resolve, reject } for the one reply being awaited
    this.queue = Promise.resolve(); // searches run one at a time
  }

  /** Starts the download, once. Resolves when the engine is ready. */
  load() {
    if (!this.loading) {
      this.loading = this._start();
      this.loading.catch(() => {}); // callers that care look at the result; the rest may ignore it
    }
    return this.loading;
  }

  async _start() {
    try {
      this.worker = new Worker(this.url);
      this.worker.onmessage = (event) => this._receive(String(event.data));
      this.worker.onerror = (event) => this._fail(new Error(event.message || 'The engine crashed'));
      await this._ask('uci', /^uciok/, this.loadTimeout);
      this.worker.postMessage('setoption name UCI_LimitStrength value true');
    } catch (error) {
      this._fail(error);
      throw error;
    }
  }

  _receive(line) {
    if (this.waiting?.pattern.test(line)) {
      const { resolve } = this.waiting;
      this.waiting = null;
      resolve(line);
    }
  }

  _ask(command, pattern, timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`The engine did not answer "${command}"`)), timeout);
      this.waiting = {
        pattern,
        resolve: (line) => { clearTimeout(timer); resolve(line); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
      this.worker.postMessage(command);
    });
  }

  /** The engine is unusable from here on. Whoever is waiting gets the error. */
  _fail(error) {
    this.failed = true;
    this.terminate(error);
  }

  terminate(error = new Error('The engine was stopped')) {
    this.worker?.terminate();
    this.worker = null;
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.reject(error);
  }

  /** Forgets the last game. */
  newGame() {
    this.queue = this.queue.catch(() => {}).then(() => { this.worker?.postMessage('ucinewgame'); });
    return this.queue;
  }

  /** Picks a move in UCI for the position in `chess`. Rejects if the engine can't answer in time. */
  bestMove(chess, elo) {
    const position = positionCommand(chess);
    const search = async () => {
      await this._loaded();
      this.worker.postMessage(`setoption name UCI_Elo value ${elo}`);
      this.worker.postMessage(position);
      try {
        const reply = await this._ask(`go movetime ${this.thinkMs}`, /^bestmove /, this.moveTimeout);
        return reply.split(' ')[1];
      } catch (error) {
        this._fail(error); // a search that hangs won't recover
        throw error;
      }
    };
    const result = this.queue.catch(() => {}).then(search);
    this.queue = result;
    return result;
  }

  /**
   * Waits once for the download, so a slow connection delays one move rather than
   * all of them. The download carries on, and the engine joins in when it arrives.
   */
  async _loaded() {
    if (this.failed) throw new Error('The engine failed to load');
    let timer;
    const tooSlow = new Promise((_, reject) => {
      timer = setTimeout(() => {
        this.loadWait = 0;
        reject(new Error('The engine is still loading'));
      }, this.loadWait);
    });
    try {
      await Promise.race([this.load(), tooSlow]);
    } finally {
      clearTimeout(timer);
    }
    if (!this.worker) throw new Error('The engine was stopped');
  }
}

/**
 * Picks a move past the real-game data. Never rejects: if the engine is missing,
 * failed or slow, the small bot plays. `source` says who chose: engine, slip or bot.
 */
export async function chooseMove(chess, rating, engine, random = Math.random) {
  const fallback = () => ({ san: botMove(chess, rating, random), source: 'bot' });
  if (!engine) return fallback();
  const { elo, slipChance } = engineSettings(rating);
  if (random() < slipChance) {
    if (engine.failed) return fallback();
    return { san: botMove(chess, Math.min(rating, SLIP_RATING), random), source: 'slip' };
  }
  try {
    return { san: sanFromUci(chess, await engine.bestMove(chess, elo)), source: 'engine' };
  } catch {
    return fallback();
  }
}
