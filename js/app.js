// Screens and wiring: setup form, training session and the customize sheet.
import { Chess } from '../vendor/chess.js';
import { Appearance, BOARD_THEMES } from './appearance.js';
import { Board } from './board.js';
import { blendRows, loadBand, loadMeta, loadOpenings, rowsFor } from './book.js';
import { Engine, ENGINE_FLOOR } from './bot.js';
import { Progress } from './progress.js';
import { bandsByDistance, bandsInRange, drawOpponent, fromLichess, LEVELS, opponentRange, SCALES } from './rating.js';
import { analyseGame, buildReview, isBookMove } from './review.js';
import { ReviewPanel } from './review-panel.js';
import { MODES, Trainer, userPositions } from './trainer.js';

const RIVAL_DELAY = 500;
const WRONG_DELAY = 550;
const SITE_URL = 'https://aduhax16.github.io/ChessGym/';
const MIN_RATING = 100;
const MAX_RATING = 3500;
const LENGTHS = [
  { id: 12, label: '6' },
  { id: 20, label: '10' },
  { id: 24, label: '12' },
];
const MODE_OPTIONS = [
  { id: MODES.LEARN, label: 'Learn' },
  { id: MODES.PRACTICE, label: 'Practice' },
];
const MODE_NOTES = {
  [MODES.LEARN]: 'An arrow shows you each move.',
  [MODES.PRACTICE]: 'Play from memory. Your results count towards mastery.',
};
const COLORS = [
  { id: 'white', label: 'White' },
  { id: 'black', label: 'Black' },
];
const THEME_MODES = [
  { id: 'system', label: 'Auto' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];
const STYLES = ['Aggressive', 'Solid', 'Gambit', 'Tricky', 'Positional'];
const ALL = 'all';
const SVG_NS = 'http://www.w3.org/2000/svg';
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const FREE_ID = 'free';
const FREE_PLAY = {
  id: FREE_ID,
  name: 'Free play',
  summary: 'No script. Play any opening you like and see how people at your rating respond.',
  prefix: '',
  style: [],
  lines: [],
};

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== false) node.setAttribute(key, value);
  }
  node.append(...children.filter((child) => child !== null && child !== undefined));
  return node;
}

const percent = (value) => `${Math.round(value * 100)}%`;
const count = (value, one, many) => `${value} ${value === 1 ? one : many}`;
const scoreText = (right, wrong, hints) =>
  [`${right} correct`, count(wrong, 'mistake', 'mistakes'), count(hints, 'hint', 'hints')].join(' · ');

const progress = new Progress();
const appearance = new Appearance(progress);

const state = {
  data: null,
  meta: null,
  // Setup choices
  color: 'white',
  firstMove: ALL,
  style: ALL,
  search: '',
  openingId: null,
  rating: 1200,
  scale: 'chesscom',
  level: 'same',
  mode: MODES.PRACTICE,
  plies: 20,
  adaptive: true,
  // Session
  opening: null,
  range: null,
  books: {},
  trainer: null,
  board: null,
  generation: 0, // bumps on restart or exit, cancelling pending rival moves
  engine: null, // Stockfish, created when a free game starts
  botSources: new Set(), // who chose the rival's moves past the real-game data
  reviewPanel: null,
  reviewJob: null, // the analysis in progress for this game, if any
  lastPlayed: null,
  baseMarks: [],
  rivalNote: null,
  leftRepertoire: false,
  lastWrongAt: null,
  hintShownAt: null,
  currentLine: null,
  masteryBefore: 0,
  freeCard: null,
};

/* ---------- Small components ---------- */

function segmented(options, value, onChange) {
  return el('div', { class: 'segmented' }, ...options.map((option) => el('button', {
    type: 'button',
    class: option.id === value ? 'is-selected' : '',
    'aria-pressed': String(option.id === value),
    onclick: () => onChange(option.id),
  }, option.label)));
}

/** A static board drawn as one SVG, used for opening cards and the preview. */
function miniBoard(fen, flipped, lastMove) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 8 8');
  svg.setAttribute('class', 'mini-board');
  svg.setAttribute('aria-hidden', 'true');
  const place = (file, rank) => (flipped ? [7 - file, rank] : [file, 7 - rank]);
  const rect = (x, y, className) => {
    const square = document.createElementNS(SVG_NS, 'rect');
    Object.entries({ x, y, width: 1, height: 1, class: className }).forEach(([key, value]) => square.setAttribute(key, value));
    svg.append(square);
  };
  for (let file = 0; file < 8; file += 1) {
    for (let rank = 0; rank < 8; rank += 1) {
      const [x, y] = place(file, rank);
      rect(x, y, (file + rank) % 2 === 0 ? 'mini-dark' : 'mini-light');
    }
  }
  if (lastMove) {
    for (const square of [lastMove.from, lastMove.to]) {
      const [x, y] = place('abcdefgh'.indexOf(square[0]), Number(square[1]) - 1);
      rect(x, y, 'mini-last');
    }
  }
  fen.split(' ')[0].split('/').forEach((row, rowIndex) => {
    let file = 0;
    for (const char of row) {
      if (/\d/.test(char)) {
        file += Number(char);
      } else {
        const [x, y] = place(file, 7 - rowIndex);
        const color = char === char.toUpperCase() ? 'w' : 'b';
        const piece = document.createElementNS(SVG_NS, 'svg');
        Object.entries({ x, y, width: 1, height: 1, viewBox: '0 0 40 40' }).forEach(([key, value]) => piece.setAttribute(key, value));
        const use = document.createElementNS(SVG_NS, 'use');
        use.setAttribute('href', `assets/pieces.svg#${color}${char.toLowerCase()}`);
        piece.append(use);
        svg.append(piece);
        file += 1;
      }
    }
  });
  return svg;
}

/* ---------- Setup: settings ---------- */

function renderSettings() {
  $('color-options').replaceChildren(segmented(COLORS, state.color, (color) => {
    state.color = color;
    state.firstMove = color === 'black' ? 'e4' : ALL;
    state.openingId = null;
    renderSettings();
    renderLibrary();
    renderPlayBar();
  }));
  $('scale-options').replaceChildren(segmented(
    SCALES.map(({ id, label }) => ({ id, label })),
    state.scale,
    (scale) => { state.scale = scale; renderSettings(); renderPlayBar(); },
  ));
  $('level-options').replaceChildren(segmented(
    LEVELS.map(({ id, label }) => ({ id, label })),
    state.level,
    (level) => { state.level = level; renderSettings(); renderPlayBar(); },
  ));
  $('mode-options').replaceChildren(segmented(MODE_OPTIONS, state.mode, (mode) => {
    state.mode = mode;
    renderSettings();
  }));
  $('length-options').replaceChildren(segmented(LENGTHS, state.plies, (plies) => {
    state.plies = plies;
    renderSettings();
  }));
  $('mode-note').textContent = state.openingId === FREE_ID
    ? 'Free play has no script, so Mode and Moves don\'t apply.'
    : MODE_NOTES[state.mode];
  $('adaptive').checked = state.adaptive;
  $('rating-input').value = state.rating;
  syncSlider();
  renderRangeSummary();
}

function syncSlider() {
  const slider = $('rating-slider');
  slider.value = state.rating;
  const position = (Number(slider.value) - Number(slider.min)) / (Number(slider.max) - Number(slider.min));
  slider.style.setProperty('--fill-to', `${position * 100}%`);
}

function currentRange() {
  return opponentRange(state.rating, state.scale, state.level);
}

const roundTo25 = (value) => Math.round(value / 25) * 25;

function rangeLabel(range) {
  const scale = SCALES.find((item) => item.id === state.scale);
  const low = roundTo25(fromLichess(range.low, state.scale));
  const high = roundTo25(fromLichess(range.high, state.scale));
  return `${state.scale === 'lichess' ? '' : '≈'}${low}–${high} ${scale.label}`;
}

function renderRangeSummary() {
  const range = currentRange();
  const exact = state.scale === 'lichess' ? '' : ` (${range.low}–${range.high} on Lichess, a rough conversion)`;
  $('range-summary').textContent = `Opponents rated ${rangeLabel(range)}${exact}. A new one each game, playing a blend of real moves at that level.`;
}

function setRating(value) {
  if (!Number.isFinite(value) || value < MIN_RATING || value > MAX_RATING) return;
  state.rating = value;
  syncSlider();
  renderRangeSummary();
  renderPlayBar();
}

/* ---------- Setup: opening library ---------- */

const isFree = (opening) => opening?.id === FREE_ID;
const openingById = (id) => (id === FREE_ID ? { ...FREE_PLAY, color: state.color } : state.data.openings.find((item) => item.id === id));
const firstMoveOf = (opening) => opening.prefix.split(' ')[0];
const openingsOfColor = () => state.data.openings.filter((opening) => opening.color === state.color);

function visibleOpenings() {
  const query = state.search.trim().toLowerCase();
  return openingsOfColor().filter((opening) =>
    (state.firstMove === ALL || firstMoveOf(opening) === state.firstMove)
    && (state.style === ALL || opening.style.includes(state.style))
    && (!query || `${opening.name} ${opening.summary} ${opening.lines.map((line) => line.name).join(' ')}`.toLowerCase().includes(query)));
}

const positionCache = new Map();
function positionsOf(opening) {
  if (!positionCache.has(opening.id)) positionCache.set(opening.id, userPositions(opening));
  return positionCache.get(opening.id);
}

function prefixBoard(opening) {
  const chess = new Chess();
  let last = null;
  for (const san of opening.prefix.split(' ')) last = chess.move(san);
  return miniBoard(chess.fen(), opening.color === 'black', last);
}

/** Cards are kept between renders, because drawing dozens of boards is not free. */
const cardCache = new Map();
function openingCard(opening) {
  if (!cardCache.has(opening.id)) {
    const mastery = progress.mastery(opening.id, positionsOf(opening));
    const played = progress.played(opening.id);
    const meta = [opening.difficulty, ...opening.style.slice(0, 1), count(opening.lines.length, 'line', 'lines')].join(' · ');
    cardCache.set(opening.id, el('button', {
      type: 'button',
      class: 'opening-card',
      onclick: () => selectOpening(opening.id),
    },
    prefixBoard(opening),
    el('span', { class: 'opening-body' },
      el('span', { class: 'opening-name' }, opening.name),
      el('span', { class: 'opening-summary' }, opening.summary),
      el('span', { class: 'opening-meta' }, played ? `${percent(mastery)} mastered` : meta),
      played ? el('span', { class: 'mastery-track' }, el('span', { class: 'mastery-fill', style: `width:${mastery * 100}%` })) : null)));
  }
  const card = cardCache.get(opening.id);
  markSelected(card, opening.id);
  return card;
}

function markSelected(card, id) {
  const selected = id === state.openingId;
  card.classList.toggle('is-selected', selected);
  card.setAttribute('aria-pressed', String(selected));
}

function selectOpening(id) {
  state.openingId = id;
  history.replaceState(null, '', `#${id}`);
  for (const [openingId, card] of cardCache) markSelected(card, openingId);
  if (state.freeCard) markSelected(state.freeCard, FREE_ID);
  renderPlayBar();
  $('mode-note').textContent = id === FREE_ID
    ? 'Free play has no script, so Mode and Moves don\'t apply.'
    : MODE_NOTES[state.mode];
}

function freePlayCard() {
  state.freeCard = el('button', {
    type: 'button',
    class: 'opening-card free-card',
    onclick: () => selectOpening(FREE_ID),
  },
  miniBoard(START_FEN, state.color === 'black'),
  el('span', { class: 'opening-body' },
    el('span', { class: 'opening-name' }, FREE_PLAY.name),
    el('span', { class: 'opening-summary' }, FREE_PLAY.summary),
    el('span', { class: 'opening-meta' }, 'Any opening · No score')));
  markSelected(state.freeCard, FREE_ID);
  return state.freeCard;
}

function renderLibrary() {
  $('opening-title').textContent = state.color === 'white' ? 'Choose your opening' : 'Choose your defence';
  $('first-move-title').textContent = state.color === 'black' ? 'White plays' : 'Start with';
  const used = new Set(openingsOfColor().map(firstMoveOf));
  const moves = state.data.firstMoves.filter((move) => used.has(move.san));
  const pill = (label, value, title) => el('button', {
    type: 'button',
    class: `pill${state.firstMove === value ? ' is-selected' : ''}`,
    'aria-pressed': String(state.firstMove === value),
    title,
    onclick: () => { state.firstMove = value; renderLibrary(); renderPlayBar(); },
  }, label);
  $('first-move-options').replaceChildren(
    ...(state.color === 'white' ? [pill('All', ALL)] : []),
    ...moves.map((move) => pill(move.label, move.san, move.hint)),
  );
  renderOpeningGrid();
}

function renderOpeningGrid() {
  const openings = visibleOpenings();
  const query = state.search.trim().toLowerCase();
  const showFree = !query || 'free play'.includes(query);
  const selectedIsVisible = (state.openingId === FREE_ID && showFree) || openings.some((opening) => opening.id === state.openingId);
  if (!selectedIsVisible) state.openingId = openings[0]?.id ?? (showFree ? FREE_ID : null);
  $('opening-options').replaceChildren(
    ...(showFree ? [freePlayCard()] : []),
    ...(openings.length || showFree ? openings.map(openingCard) : [el('p', { class: 'empty' }, 'No openings match.')]),
  );
}

function renderPlayBar() {
  const opening = openingById(state.openingId);
  $('start').disabled = !opening;
  $('play-name').textContent = opening ? opening.name : 'Choose an opening';
  $('play-range').textContent = `Opponents ${rangeLabel(currentRange())}`;
}

function surpriseMe() {
  const openings = visibleOpenings();
  if (!openings.length) return;
  selectOpening(openings[Math.floor(Math.random() * openings.length)].id);
  startTraining();
}

/* ---------- Training ---------- */

async function startTraining() {
  const opening = openingById(state.openingId);
  if (!opening) return;
  progress.saveSettings({
    color: state.color, firstMove: state.firstMove, rating: state.rating, scale: state.scale, level: state.level,
    mode: state.mode, plies: state.plies, adaptive: state.adaptive, openingId: state.openingId,
  });
  const start = $('start');
  start.disabled = true;
  start.textContent = 'Loading…';
  $('setup-error').textContent = '';
  try {
    // Free play can borrow moves from any level once its own runs out of games.
    const bands = isFree(opening) ? state.meta.bands.map((band) => band.id) : bandsInRange(currentRange(), state.meta.bands);
    const ids = [...bands, 'reference'];
    const entries = await Promise.all(ids.map(async (id) => [id, await loadBand(id)]));
    state.books = Object.fromEntries(entries);
    state.opening = opening;
    state.range = currentRange();
    $('setup').hidden = true;
    $('training').hidden = false;
    window.scrollTo(0, 0);
    newSession();
  } catch (error) {
    $('setup-error').textContent = `${error.message}. Check your connection and try again.`;
  } finally {
    start.disabled = false;
    start.textContent = 'Play';
  }
}

/** Downloads the engine in the background as a free game starts, so its first move is ready. */
function freePlayEngine() {
  if (!state.engine || state.engine.failed) state.engine = new Engine();
  state.engine.load();
  state.engine.newGame();
  return state.engine;
}

function newSession() {
  state.generation += 1;
  closeReview();
  state.reviewPanel?.reset();
  state.reviewJob = null;
  const opponent = drawOpponent(state.range, state.meta.bands);
  state.trainer = new Trainer({
    opening: state.opening,
    opponent,
    books: state.books,
    progress,
    mode: state.mode,
    plies: state.plies,
    adaptive: state.adaptive,
    free: isFree(state.opening),
    nearbyBands: bandsByDistance(opponent.rating, state.meta.bands),
    engine: isFree(state.opening) ? freePlayEngine() : null,
  });
  state.botSources = new Set();
  state.masteryBefore = isFree(state.opening) ? 0 : progress.mastery(state.opening.id, positionsOf(state.opening));
  state.lastPlayed = null;
  state.baseMarks = [];
  state.rivalNote = null;
  state.leftRepertoire = false;
  state.lastWrongAt = null;
  state.hintShownAt = null;
  state.currentLine = null;
  if (!state.board) state.board = new Board($('board'), { onMove: handleUserMove });
  state.board.setOrientation(state.opening.color === 'white' ? 'w' : 'b');
  state.board.clearArrows();
  state.board.setMarks([]);
  state.board.setPosition(state.trainer.fen);
  $('training-title').textContent = state.opening.name;
  const modeName = isFree(state.opening) ? 'Free play' : (state.mode === MODES.LEARN ? 'Learn' : 'Practice');
  $('training-meta').textContent = `Against ${opponentLabel(opponent)} · ${modeName}`;
  $('next-line').textContent = isFree(state.opening) ? 'New game' : 'Next line';
  $('finish-card').hidden = true;
  $('session-actions').hidden = false;
  $('resign').hidden = !isFree(state.opening);
  setStatus('', '');
  nextTurn();
}

function opponentLabel(opponent) {
  const scale = SCALES.find((item) => item.id === state.scale);
  const value = Math.round(fromLichess(opponent.rating, state.scale) / 10) * 10;
  return state.scale === 'lichess' ? `${opponent.rating} Lichess` : `≈${value} ${scale.label}`;
}

function setStatus(tone, title, detail = '') {
  $('status').dataset.tone = tone;
  $('status-title').textContent = title;
  $('status-detail').textContent = detail;
}

function nextTurn() {
  const { trainer, board } = state;
  renderPanel();
  if (trainer.done) {
    finish();
    return;
  }
  if (trainer.isUserTurn) {
    promptUser();
    return;
  }
  board.setMovable(null);
  const generation = state.generation;
  setTimeout(async () => {
    if (generation !== state.generation) return;
    const played = await trainer.playRivalWithEngine();
    if (generation !== state.generation) return;
    state.lastPlayed = { ...played, by: 'rival' };
    showPosition();
    if (played.bot) {
      state.botSources.add(played.source);
      state.rivalNote = `${played.san}. ${botNote(played.source, trainer.opponent)}`;
    } else if (!played.forced) {
      state.rivalNote = played.row
        ? `${played.san} is played by ${percent(played.row.share)} at this level.`
        : `Your opponent played ${played.san}.`;
    }
    nextTurn();
  }, RIVAL_DELAY);
}

/** Says who is choosing the opponent's moves now that the real games have run out. */
function botNote(source, opponent) {
  if (source === 'bot') return 'Past the real-game data, a simple bot plays while Stockfish isn\'t available.';
  return opponent.rating < ENGINE_FLOOR
    ? `Past the real-game data, Stockfish plays at its weakest, with extra mistakes to match ${opponentLabel(opponent)}.`
    : `Past the real-game data, Stockfish plays for your opponent, limited to ${opponentLabel(opponent)}.`;
}

function showPosition() {
  const { trainer, board } = state;
  board.setPosition(trainer.fen);
  const marks = [];
  const last = trainer.moves[trainer.moves.length - 1];
  if (last) marks.push([last.from, 'mark-last'], [last.to, 'mark-last']);
  if (trainer.chess.isCheck()) {
    const color = trainer.chess.turn();
    const king = trainer.chess.board().flat().find((piece) => piece?.type === 'k' && piece.color === color);
    if (king) marks.push([king.square, 'mark-check']);
  }
  board.clearArrows();
  board.setMarks(marks);
  state.baseMarks = marks;
}

function promptUser() {
  const { trainer, board } = state;
  const expected = trainer.expected();
  board.setMovable(trainer.userColor, destsFor);
  const note = state.rivalNote ?? '';
  state.rivalNote = null;
  if (expected.source === 'free') {
    setStatus('turn', 'Your move', note || 'Play anything you like.');
    return;
  }
  if (expected.source === 'reference') {
    const names = trainer.referenceRows().map((row) => row.san).join(', ');
    const isFirst = !state.leftRepertoire;
    state.leftRepertoire = true;
    const text = state.mode === MODES.LEARN
      ? `Strong players choose ${names}.`
      : `Any common move at ${state.meta.referenceMinElo}+ counts.`;
    setStatus('info', isFirst ? 'Out of your repertoire' : 'Your move', [note, text].filter(Boolean).join(' '));
  } else {
    setStatus('turn', 'Your move', note || (state.mode === MODES.LEARN ? 'Follow the arrow.' : 'Play from memory.'));
  }
  if (state.mode === MODES.LEARN) revealArrow();
}

function destsFor(square) {
  return state.trainer.chess.moves({ square, verbose: true })
    .filter((move, index, all) => all.findIndex((other) => other.to === move.to) === index)
    .map((move) => ({ to: move.to, capture: Boolean(move.captured) }));
}

function revealArrow() {
  const move = state.trainer.expectedMoveDetails();
  if (move) state.board.showArrow(move.from, move.to);
}

function handleUserMove(from, to) {
  const { trainer, board } = state;
  const legal = trainer.chess.moves({ square: from, verbose: true }).filter((move) => move.to === to);
  // Promotions in opening play are nearly always to a queen.
  const move = legal.find((item) => !item.promotion || item.promotion === 'q');
  if (!move) return;

  const before = trainer.fen;
  const result = trainer.tryMove(move.san);
  if (result.ok) {
    state.lastPlayed = { san: move.san, before, by: 'user' };
    showPosition();
    if (result.source === 'free') setStatus('', 'Opponent thinking', `You played ${move.san}.`);
    else setStatus('good', result.source === 'reference' ? 'Good move' : 'Correct', `You played ${move.san}.`);
    nextTurn();
    return;
  }

  const preview = new Chess(before);
  preview.move(move.san);
  board.setMovable(null);
  board.setPosition(preview.fen());
  board.setMarks([...state.baseMarks, [to, 'mark-wrong']]);
  board.shake();
  const detail = result.playable
    ? `${move.san} is playable (${percent(result.playable.share)} at ${state.meta.referenceMinElo}+), but you're practising another move.`
    : `${move.san} isn't the move you're practising.`;
  setStatus('bad', 'Try again', detail);
  renderPanel();
  const generation = state.generation;
  setTimeout(() => {
    if (generation !== state.generation) return;
    board.setPosition(before);
    board.setMarks(state.baseMarks);
    board.setMovable(trainer.userColor, destsFor);
    if (state.lastWrongAt === trainer.ply) revealArrow();
    state.lastWrongAt = trainer.ply;
  }, WRONG_DELAY);
}

function requestHint() {
  const { trainer, board } = state;
  if (!trainer.isUserTurn) return;
  const move = trainer.useHint();
  if (!move) {
    setStatus('info', 'No hint here', 'Strong players rarely reach this position.');
    return;
  }
  if (trainer.free) {
    revealArrow();
    setStatus('info', 'Hint', `Strong players often choose ${move.san} here.`);
    return;
  }
  if (state.hintShownAt === trainer.ply) {
    revealArrow();
  } else {
    state.hintShownAt = trainer.ply;
    board.setMarks([...state.baseMarks, [move.from, 'mark-hint']]);
    setStatus('info', 'Hint', 'Move the highlighted piece. Tap Hint again to see where.');
  }
  renderPanel();
}

/** The named opening with the longest match for the moves played so far. */
function detectOpening(history) {
  const played = history.join(' ');
  let best = null;
  for (const opening of state.data.openings) {
    const prefix = opening.prefix;
    if (prefix.includes(' ') && (played === prefix || played.startsWith(`${prefix} `)) && prefix.length > (best?.prefix.length ?? 0)) {
      best = opening;
    }
  }
  return best;
}

function renderFreePanel() {
  const { trainer } = state;
  const opening = detectOpening(trainer.history);
  $('line-name').textContent = opening ? opening.name.replace(/^(Beating|1\.\.\.\w+ vs) (the )?/, '') : 'Your opening';
  $('line-idea').textContent = opening ? opening.summary : 'Play a few moves and we\'ll name the opening when we recognise it.';
  renderMoves();
  renderStats();
  $('score').textContent = count(Math.ceil(trainer.ply / 2), 'move', 'moves');
}

function renderPanel() {
  const { trainer } = state;
  if (trainer.free) {
    renderFreePanel();
    return;
  }
  const lines = trainer.matchingLines();
  if (lines.length === 1) state.currentLine = lines[0];
  $('line-name').textContent = state.currentLine?.name ?? 'The idea';
  // While practising from memory, the plan would give the answer away.
  const showIdea = state.mode === MODES.LEARN || trainer.done;
  $('line-idea').textContent = showIdea && state.currentLine
    ? state.currentLine.idea
    : state.opening.summary;
  renderMoves();
  renderStats();
  $('score').textContent = scoreText(trainer.answered, trainer.mistakes, trainer.hintsUsed);
}

function renderMoves() {
  const { history } = state.trainer;
  const rows = [];
  for (let index = 0; index < history.length; index += 2) {
    rows.push(el('li', {},
      el('span', { class: 'move-num' }, `${index / 2 + 1}.`),
      el('span', { class: 'move' }, history[index]),
      el('span', { class: 'move' }, history[index + 1] ?? '')));
  }
  const list = $('moves');
  list.replaceChildren(...rows);
  list.scrollTop = list.scrollHeight;
}

function renderStats() {
  const last = state.lastPlayed;
  const box = $('stats');
  const rows = last ? blendRows(state.books, state.trainer.opponent.mix, last.before) : [];
  if (!rows.length) {
    $('stats-title').textContent = 'At this level';
    box.replaceChildren(el('p', { class: 'muted' }, last ? 'Too few games in that position.' : 'Appears after the first move.'));
    return;
  }
  const games = rows.reduce((sum, row) => sum + row.games, 0).toLocaleString('en');
  $('stats-title').textContent = `Before ${last.san}, at this level`;
  box.replaceChildren(
    el('div', { class: 'stats-head' }, el('span', {}, 'Move'), el('span', {}, 'Played by'), el('span', {}, 'Result')),
    ...topRowsWith(rows, last.san).map((row) => statRow(row, row.san === last.san)),
    el('p', { class: 'stats-foot' }, `${games} games. Results: White, draw, Black.`),
  );
}

/** The most common moves, always including the one that was played. */
function topRowsWith(rows, san) {
  const top = rows.slice(0, 5);
  const played = rows.find((row) => row.san === san);
  return played && !top.includes(played) ? [...top.slice(0, 4), played] : top;
}

function statRow(row, played) {
  const segment = (kind, value) => el('span', { class: `result-${kind}`, style: `width:${value * 100}%`, title: percent(value) });
  return el('div', { class: `stats-row${played ? ' is-played' : ''}` },
    el('span', {}, row.san),
    el('span', { class: 'stats-share' },
      el('span', { class: 'share-track' }, el('span', { class: 'share-fill', style: `width:${row.share * 100}%` })),
      el('span', { class: 'share-value' }, percent(row.share))),
    el('span', { class: 'result-bar', role: 'img', 'aria-label': `White ${percent(row.white)}, draw ${percent(row.draws)}, Black ${percent(row.black)}` },
      segment('white', row.white), segment('draw', row.draws), segment('black', row.black)));
}

function finishFreeGame() {
  const { chess, userColor } = state.trainer;
  const won = chess.isCheckmate() && chess.turn() !== userColor;
  if (state.trainer.endReason === 'resigned') setStatus('bad', 'You resigned', 'Review the game to see where it turned.');
  else if (!chess.isCheckmate()) setStatus('info', 'Draw', 'Nobody could make progress.');
  else if (won) setStatus('good', 'You won', 'Checkmate.');
  else setStatus('bad', 'You lost', 'Checkmate. Review the game to see where it turned.');
  $('finish-score').textContent = `${count(Math.ceil(state.trainer.ply / 2), 'move', 'moves')} played.`;
  const sources = state.botSources;
  const engineUsed = sources.has('engine') || sources.has('slip');
  let credit = 'Every move came from real games.';
  if (engineUsed && sources.has('bot')) credit = 'The opening came from real games, the rest from Stockfish and, while it wasn\'t available, a simple bot.';
  else if (engineUsed) credit = 'The opening came from real games, the rest from Stockfish limited to this rating.';
  else if (sources.has('bot')) credit = 'The opening came from real games, the rest from a simple bot because Stockfish wasn\'t available.';
  $('finish-mastery').textContent = credit;
}

function finish() {
  const { trainer, board } = state;
  board.setMovable(null);
  $('analysis-link').href = `https://lichess.org/analysis/${trainer.fen.replace(/ /g, '_')}`;
  $('share').textContent = 'Share';
  $('finish-card').hidden = false;
  $('session-actions').hidden = true;
  $('review-open').hidden = trainer.ply === 0;
  // A review is the natural next step after a game, a new line after a drill.
  $('review-open').className = trainer.free ? 'primary' : 'secondary';
  $('next-line').className = trainer.free ? 'secondary' : 'primary';
  if (trainer.free) {
    finishFreeGame();
    return;
  }
  const summary = trainer.summary();
  const headlines = {
    complete: summary.clean && state.mode === MODES.PRACTICE ? 'Perfect line' : 'Line complete',
    gameOver: 'Game over',
    noReference: 'You left theory behind',
    noData: 'You left theory behind',
  };
  const details = {
    complete: 'You reached the end of this line.',
    gameOver: 'It finished before the end of the line.',
    noReference: 'Strong players almost never reach this position, which often means your opponent went wrong. Open it on Lichess to see how to punish it.',
    noData: 'Too few people at this level have reached this position. Open it on Lichess to keep exploring.',
  };
  setStatus(summary.clean ? 'good' : 'info', headlines[summary.endReason], details[summary.endReason]);
  $('finish-score').textContent = state.mode === MODES.LEARN
    ? 'When it feels familiar, switch to Practice.'
    : scoreText(summary.answered, summary.mistakes, summary.hints);
  const mastery = progress.mastery(state.opening.id, positionsOf(state.opening));
  const before = Math.round(state.masteryBefore * 100);
  const now = Math.round(mastery * 100);
  const change = now === before ? '' : `, ${now > before ? 'up' : 'down'} from ${before}%`;
  $('finish-mastery').textContent = `${now}% of this opening mastered${change}.`;
}

function resign() {
  const { trainer } = state;
  if (!trainer.free || trainer.done) return;
  state.generation += 1; // cancels a rival move still on its way
  trainer.resign();
  nextTurn();
}

/* ---------- Game review ---------- */

function reviewPanel() {
  if (!state.reviewPanel) {
    state.reviewPanel = new ReviewPanel({ board: state.board, onClose: closeReview, onRetry: runReview });
  }
  return state.reviewPanel;
}

function openReview() {
  const { trainer } = state;
  const panel = reviewPanel();
  panel.open(trainer.userColor, `${state.opening.name} · against ${opponentLabel(trainer.opponent)}`);
  if (panel.review) panel.show(panel.review);
  else if (!state.reviewJob) runReview();
}

async function runReview() {
  const { trainer, books, generation } = state;
  const panel = reviewPanel();
  if (!state.engine || state.engine.failed) state.engine = new Engine();
  panel.showProgress(0, trainer.moves.length + 1);
  const isCurrent = () => generation === state.generation;
  const job = analyseGame(state.engine, trainer.moves, {
    isCancelled: () => !isCurrent(),
    onProgress: (done, total) => { if (isCurrent()) panel.showProgress(done, total); },
  });
  state.reviewJob = job;
  try {
    const positions = await job;
    if (!positions || !isCurrent()) return;
    const isBook = (fen, san) => isBookMove(rowsFor(books.reference, fen), san);
    panel.review = buildReview(trainer.moves, positions, isBook);
    if (panel.isOpen) panel.show(panel.review);
  } catch {
    if (isCurrent()) panel.showError('The engine couldn\'t run. Check your connection and try again.');
  } finally {
    if (state.reviewJob === job) state.reviewJob = null;
  }
}

function closeReview() {
  const panel = state.reviewPanel;
  if (!panel?.isOpen) return;
  panel.close();
  if (!state.trainer) return;
  state.board.setPosition(state.trainer.fen);
  state.board.clearArrows();
  state.board.setMarks(state.baseMarks);
}

async function shareResult() {
  if (state.trainer.free) {
    await sendShare(`I just played a free game against a ${opponentLabel(state.trainer.opponent)} opponent on ChessGym`, SITE_URL);
    return;
  }
  const summary = state.trainer.summary();
  const outcome = summary.clean ? 'a perfect line' : `a line with ${count(summary.mistakes, 'mistake', 'mistakes')}`;
  const text = `I played ${outcome} of the ${state.opening.name} against a ${opponentLabel(state.trainer.opponent)} opponent on ChessGym`;
  await sendShare(text, `${SITE_URL}#${state.opening.id}`);
}

async function sendShare(text, url) {
  try {
    if (navigator.share) {
      await navigator.share({ text, url });
    } else {
      await navigator.clipboard.writeText(`${text}: ${url}`);
      $('share').textContent = 'Copied';
    }
  } catch {
    // The person cancelled the share sheet or clipboard access is blocked.
  }
}

function exitTraining() {
  state.generation += 1;
  closeReview();
  state.engine?.terminate(); // it holds a lot of memory, and restarts quickly from the browser's cache
  state.engine = null;
  cardCache.clear(); // mastery may have changed
  $('training').hidden = true;
  $('setup').hidden = false;
  renderSettings();
  renderLibrary();
  renderPlayBar();
}

/* ---------- Customize sheet ---------- */

const PREVIEW_FEN = 'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3';

function renderCustomizer() {
  const { prefs } = appearance;
  $('customize-preview').replaceChildren(miniBoard(PREVIEW_FEN, false, { from: 'f1', to: 'b5' }));
  const swatch = (light, dark) => el('span', { class: 'theme-swatch' },
    ...[light, dark, dark, light].map((color) => el('span', { style: `background:${color}` })));
  $('theme-options').replaceChildren(
    ...BOARD_THEMES.map((theme) => el('button', {
      type: 'button',
      class: `theme-option${prefs.board === theme.id ? ' is-selected' : ''}`,
      'aria-pressed': String(prefs.board === theme.id),
      onclick: () => {
        appearance.set({ board: theme.id, customLight: theme.light, customDark: theme.dark });
        renderCustomizer();
      },
    }, swatch(theme.light, theme.dark), theme.label)),
  );
  const { light, dark } = appearance.colors;
  $('custom-light').value = light;
  $('custom-dark').value = dark;
  $('theme-mode-options').replaceChildren(segmented(THEME_MODES, prefs.theme, (theme) => {
    appearance.set({ theme });
    renderCustomizer();
  }));
  $('pref-coordinates').checked = prefs.coordinates;
  $('pref-animation').checked = prefs.animation;
}

function wireCustomizer() {
  const sheet = $('customize');
  $('customize-open').addEventListener('click', () => {
    renderCustomizer();
    sheet.showModal();
  });
  $('customize-close').addEventListener('click', () => sheet.close());
  // A click on the dialog element itself is a click on its backdrop.
  sheet.addEventListener('click', (event) => {
    if (event.target === sheet) sheet.close();
  });
  const setCustomColor = () => {
    appearance.set({ board: 'custom', customLight: $('custom-light').value, customDark: $('custom-dark').value });
    renderCustomizer();
  };
  $('custom-light').addEventListener('input', setCustomColor);
  $('custom-dark').addEventListener('input', setCustomColor);
  $('pref-coordinates').addEventListener('change', (event) => appearance.set({ coordinates: event.target.checked }));
  $('pref-animation').addEventListener('change', (event) => appearance.set({ animation: event.target.checked }));
  $('reset-progress').addEventListener('click', () => {
    if (window.confirm('Delete all the progress saved in this browser?')) {
      progress.reset();
      cardCache.clear();
      renderLibrary();
    }
  });
}

/* ---------- Startup ---------- */

function applyDeepLink() {
  const id = decodeURIComponent(location.hash.slice(1));
  if (id === FREE_ID) {
    state.openingId = FREE_ID;
    return;
  }
  const opening = state.data.openings.find((item) => item.id === id);
  if (!opening) return;
  state.color = opening.color;
  state.firstMove = opening.color === 'black' ? firstMoveOf(opening) : ALL;
  state.style = ALL;
  state.openingId = opening.id;
}

async function main() {
  wireCustomizer();
  try {
    const [data, meta] = await Promise.all([loadOpenings(), loadMeta()]);
    state.data = data;
    state.meta = meta;
  } catch (error) {
    $('setup-error').textContent = `${error.message}.`;
    return;
  }
  $('hero-text').textContent = `Your opponent plays what real people at your rating play, from ${(state.meta.games / 1e6).toFixed(1)} million games. ${state.data.openings.length} openings.`;

  const saved = progress.settings;
  for (const key of ['color', 'firstMove', 'rating', 'scale', 'level', 'mode', 'plies', 'adaptive', 'openingId']) {
    if (saved[key] !== undefined) state[key] = saved[key];
  }
  applyDeepLink();

  $('style-filter').replaceChildren(
    el('option', { value: ALL }, 'Any style'),
    ...STYLES.map((style) => el('option', { value: style }, style)),
  );
  renderSettings();
  renderLibrary();
  renderPlayBar();

  $('start').addEventListener('click', startTraining);
  $('surprise').addEventListener('click', surpriseMe);
  $('search').addEventListener('input', (event) => {
    state.search = event.target.value;
    renderOpeningGrid();
    renderPlayBar();
  });
  $('style-filter').addEventListener('change', (event) => {
    state.style = event.target.value;
    renderOpeningGrid();
    renderPlayBar();
  });
  $('rating-input').addEventListener('input', (event) => setRating(Number(event.target.value)));
  $('rating-input').addEventListener('blur', () => { $('rating-input').value = state.rating; });
  $('rating-slider').addEventListener('input', (event) => {
    setRating(Number(event.target.value));
    $('rating-input').value = state.rating;
  });
  $('adaptive').addEventListener('change', (event) => { state.adaptive = event.target.checked; });
  $('hint').addEventListener('click', requestHint);
  $('restart').addEventListener('click', newSession);
  $('resign').addEventListener('click', resign);
  $('review-open').addEventListener('click', openReview);
  $('next-line').addEventListener('click', newSession);
  $('share').addEventListener('click', shareResult);
  $('back').addEventListener('click', exitTraining);
  $('back-setup').addEventListener('click', exitTraining);
  window.addEventListener('hashchange', () => {
    applyDeepLink();
    if ($('training').hidden) {
      renderSettings();
      renderLibrary();
      renderPlayBar();
    }
  });
}

main();
