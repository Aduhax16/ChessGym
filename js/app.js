// Screens and wiring: setup form and training session.
import { Chess } from '../vendor/chess.js';
import { Board } from './board.js';
import { blendRows, loadBand, loadMeta, loadOpenings } from './book.js';
import { Progress } from './progress.js';
import { bandsInRange, drawOpponent, fromLichess, LEVELS, opponentRange, SCALES } from './rating.js';
import { MODES, Trainer, userPositions } from './trainer.js';

const RIVAL_DELAY = 500;
const WRONG_DELAY = 550;
const SITE_URL = 'https://aduhax16.github.io/ChessGym/';
const LENGTHS = [
  { plies: 12, label: 'Short', hint: '6 moves' },
  { plies: 20, label: 'Medium', hint: '10 moves' },
  { plies: 24, label: 'Long', hint: '12 moves' },
];
const MODE_OPTIONS = [
  { id: MODES.LEARN, label: 'Learn', hint: 'An arrow shows you every move' },
  { id: MODES.PRACTICE, label: 'Practice', hint: 'Play from memory and track progress' },
];
const STYLES = ['Aggressive', 'Solid', 'Gambit', 'Tricky', 'Positional'];
const ALL = 'all';
const MIN_RATING = 100;
const MAX_RATING = 3500;

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
  [count(right, 'correct', 'correct'), count(wrong, 'mistake', 'mistakes'), count(hints, 'hint', 'hints')].join(' · ');

const state = {
  progress: new Progress(),
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
  books: {},
  trainer: null,
  board: null,
  generation: 0, // bumps on restart or exit, cancelling pending rival moves
  lastPlayed: null,
  baseMarks: [],
  rivalNote: null,
  leftRepertoire: false,
  lastWrongAt: null,
  hintShownAt: null,
  currentLine: null,
};

const positionCache = new Map();
function positionsOf(opening) {
  if (!positionCache.has(opening.id)) positionCache.set(opening.id, userPositions(opening));
  return positionCache.get(opening.id);
}

/* ---------- Setup screen ---------- */

function optionButton({ label, hint, selected, onclick }) {
  return el('button', { type: 'button', class: `option${selected ? ' is-selected' : ''}`, 'aria-pressed': String(selected), onclick },
    el('span', { class: 'option-label' }, label),
    hint ? el('span', { class: 'option-hint' }, hint) : null);
}

function chip(label, selected, onclick) {
  return el('button', { type: 'button', class: `chip${selected ? ' is-selected' : ''}`, 'aria-pressed': String(selected), onclick }, label);
}

function pieceIcon(piece) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 40 40');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('color-icon');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `assets/pieces.svg#${piece}`);
  svg.append(use);
  return svg;
}

const firstMoveOf = (opening) => opening.prefix.split(' ')[0];

function openingsOfColor() {
  return state.data.openings.filter((opening) => opening.color === state.color);
}

function visibleOpenings() {
  const query = state.search.trim().toLowerCase();
  return openingsOfColor().filter((opening) =>
    (state.firstMove === ALL || firstMoveOf(opening) === state.firstMove)
    && (state.style === ALL || opening.style.includes(state.style))
    && (!query || `${opening.name} ${opening.summary} ${opening.lines.map((line) => line.name).join(' ')}`.toLowerCase().includes(query)));
}

function selectOpening(id) {
  state.openingId = id;
  history.replaceState(null, '', `#${id}`);
  renderOpeningGrid();
  renderStartBar();
}

function renderColor() {
  $('color-options').replaceChildren(
    ...[
      { id: 'white', label: 'White', hint: 'Pick your opening', piece: 'wk' },
      { id: 'black', label: 'Black', hint: 'Pick what White plays, then your defence', piece: 'bk' },
    ].map((option) => {
      const button = optionButton({
        ...option,
        selected: state.color === option.id,
        onclick: () => {
          state.color = option.id;
          state.firstMove = option.id === 'black' ? 'e4' : ALL;
          state.openingId = null;
          renderSetup();
        },
      });
      button.prepend(pieceIcon(option.piece));
      button.classList.add('color-option');
      return button;
    }),
  );
}

function renderFilters() {
  const used = new Set(openingsOfColor().map(firstMoveOf));
  $('first-move-title').textContent = state.color === 'black' ? 'What should White play?' : 'Your first move';
  const moves = state.data.firstMoves.filter((move) => used.has(move.san));
  $('first-move-options').replaceChildren(
    ...(state.color === 'white' ? [chip('All', state.firstMove === ALL, () => setFirstMove(ALL))] : []),
    ...moves.map((move) => {
      const button = chip(move.label, state.firstMove === move.san, () => setFirstMove(move.san));
      button.title = move.hint;
      return button;
    }),
  );
  $('style-options').replaceChildren(
    chip('Any style', state.style === ALL, () => setStyle(ALL)),
    ...STYLES.map((style) => chip(style, state.style === style, () => setStyle(style))),
  );
  $('opening-title').textContent = state.color === 'white' ? 'Choose your opening' : 'Choose your defence';
}

function setFirstMove(move) {
  state.firstMove = move;
  renderFilters();
  renderOpeningGrid();
  renderStartBar();
}

function setStyle(style) {
  state.style = style;
  renderFilters();
  renderOpeningGrid();
  renderStartBar();
}

function openingCard(opening) {
  const mastery = state.progress.mastery(opening.id, positionsOf(opening));
  const played = state.progress.played(opening.id);
  const selected = state.openingId === opening.id;
  return el('button', {
    type: 'button',
    class: `opening-card${selected ? ' is-selected' : ''}`,
    'aria-pressed': String(selected),
    onclick: () => selectOpening(opening.id),
  },
  el('span', { class: 'opening-head' },
    el('span', { class: 'opening-name' }, opening.name),
    el('span', { class: `badge badge-${opening.difficulty.toLowerCase()}` }, opening.difficulty)),
  el('span', { class: 'opening-moves' }, movesText(opening.prefix.split(' '))),
  el('span', { class: 'opening-summary' }, opening.summary),
  el('span', { class: 'opening-tags' }, ...opening.style.map((style) => el('span', { class: 'tag' }, style))),
  el('span', { class: 'mastery' },
    el('span', { class: 'mastery-track' }, el('span', { class: 'mastery-fill', style: `width:${mastery * 100}%` })),
    el('span', { class: 'mastery-label' }, played ? `${percent(mastery)} mastered` : count(opening.lines.length, 'line', 'lines'))));
}

function movesText(moves) {
  return moves.map((san, index) => (index % 2 === 0 ? `${index / 2 + 1}.${san}` : san)).join(' ');
}

function renderOpeningGrid() {
  const openings = visibleOpenings();
  if (!openings.some((opening) => opening.id === state.openingId)) state.openingId = openings[0]?.id ?? null;
  $('opening-count').textContent = count(openings.length, 'opening', 'openings');
  $('opening-options').replaceChildren(
    ...(openings.length ? openings.map(openingCard) : [el('p', { class: 'muted empty' }, 'No opening matches those filters.')]),
  );
}

function currentRange() {
  return opponentRange(state.rating, state.scale, state.level);
}

function roundTo25(value) {
  return Math.round(value / 25) * 25;
}

function rangeLabel(range) {
  const scale = SCALES.find((item) => item.id === state.scale);
  const low = roundTo25(fromLichess(range.low, state.scale));
  const high = roundTo25(fromLichess(range.high, state.scale));
  return `${state.scale === 'lichess' ? '' : '≈'}${low}–${high} ${scale.label}`;
}

function renderRating() {
  $('rating-input').value = state.rating;
  $('rating-slider').value = state.rating;
  $('scale-options').replaceChildren(
    ...SCALES.map((scale) => chip(scale.label, state.scale === scale.id, () => {
      state.scale = scale.id;
      renderRating();
      renderStartBar();
    })),
  );
  $('level-options').replaceChildren(
    ...LEVELS.map((level) => optionButton({
      ...level,
      selected: state.level === level.id,
      onclick: () => {
        state.level = level.id;
        renderRating();
        renderStartBar();
      },
    })),
  );
  renderRatingSummary();
}

function renderRatingSummary() {
  const range = currentRange();
  const lichess = state.scale === 'lichess' ? '' : ` (${range.low}–${range.high} on Lichess)`;
  $('range-summary').textContent = `You'll face opponents rated ${rangeLabel(range)}${lichess}. Each game draws a new one, who plays a blend of what real players at that rating actually play.`;
  const scaleName = SCALES.find((item) => item.id === state.scale).label;
  const games = state.meta.games.toLocaleString('en');
  $('band-note').textContent = state.scale === 'lichess'
    ? `Built from ${games} real rated Lichess games (blitz, rapid and classical).`
    : `Built from ${games} real rated Lichess games. There is no official conversion from ${scaleName}, so this is a rough estimate: use Easier or Harder if it feels off.`;
}

function renderModes() {
  $('mode-options').replaceChildren(
    ...MODE_OPTIONS.map((mode) => optionButton({
      ...mode,
      selected: state.mode === mode.id,
      onclick: () => { state.mode = mode.id; renderModes(); },
    })),
  );
  $('length-options').replaceChildren(
    ...LENGTHS.map((length) => optionButton({
      ...length,
      selected: state.plies === length.plies,
      onclick: () => { state.plies = length.plies; renderModes(); },
    })),
  );
  $('adaptive').checked = state.adaptive;
}

function renderStartBar() {
  const opening = state.data.openings.find((item) => item.id === state.openingId);
  const start = $('start');
  start.disabled = !opening;
  start.textContent = opening ? `Play ${opening.name}` : 'Choose an opening';
  $('start-range').textContent = rangeLabel(currentRange());
}

function renderSetup() {
  renderColor();
  renderFilters();
  renderOpeningGrid();
  renderRating();
  renderModes();
  renderStartBar();
}

function surpriseMe() {
  const openings = visibleOpenings();
  if (!openings.length) return;
  selectOpening(openings[Math.floor(Math.random() * openings.length)].id);
  startTraining();
}

/* ---------- Training screen ---------- */

async function startTraining() {
  const opening = state.data.openings.find((item) => item.id === state.openingId);
  if (!opening) return;
  state.progress.saveSettings({
    color: state.color, firstMove: state.firstMove, rating: state.rating, scale: state.scale, level: state.level,
    mode: state.mode, plies: state.plies, adaptive: state.adaptive, openingId: state.openingId,
  });
  const start = $('start');
  start.disabled = true;
  start.textContent = 'Loading games…';
  $('setup-error').textContent = '';
  try {
    const ids = [...bandsInRange(currentRange(), state.meta.bands), 'reference'];
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
    renderStartBar();
  }
}

function newSession() {
  state.generation += 1;
  const opponent = drawOpponent(state.range, state.meta.bands);
  state.trainer = new Trainer({
    opening: state.opening,
    opponent,
    books: state.books,
    progress: state.progress,
    mode: state.mode,
    plies: state.plies,
    adaptive: state.adaptive,
  });
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
  $('training-meta').textContent = `Opponent: ${opponentLabel(opponent)} · ${state.mode === MODES.LEARN ? 'Learn' : 'Practice'}`;
  $('finish-card').hidden = true;
  $('session-actions').hidden = false;
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
  if (trainer.done) return finish();
  if (trainer.isUserTurn) return promptUser();
  board.setMovable(null);
  const generation = state.generation;
  setTimeout(() => {
    if (generation !== state.generation) return;
    const played = trainer.playRival();
    state.lastPlayed = { ...played, by: 'rival' };
    showPosition();
    if (!played.forced) {
      state.rivalNote = played.row
        ? `Your opponent played ${played.san}, chosen by ${percent(played.row.share)} at this level.`
        : `Your opponent played ${played.san}.`;
    }
    nextTurn();
  }, RIVAL_DELAY);
  return undefined;
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
  if (expected.source === 'reference') {
    const names = trainer.referenceRows().map((row) => row.san).join(', ');
    const isFirst = !state.leftRepertoire;
    state.leftRepertoire = true;
    const text = state.mode === MODES.LEARN
      ? `Strong players choose: ${names}.`
      : `Play what a strong player would. Any common move at ${state.meta.referenceMinElo}+ counts.`;
    setStatus('info', isFirst ? 'Out of your repertoire' : 'Use your judgement', [note, text].filter(Boolean).join(' '));
  } else {
    setStatus('turn', 'Your move', note || (state.mode === MODES.LEARN ? 'Follow the arrow.' : 'Play the move from your repertoire.'));
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
    setStatus('good', result.source === 'reference' ? 'Good: strong players play that' : 'Correct', `You played ${move.san}.`);
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
    ? `${move.san} is playable (${percent(result.playable.share)} at ${state.meta.referenceMinElo}+), but you're practising a different move here.`
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
  if (!move) return;
  if (state.hintShownAt === trainer.ply) {
    revealArrow();
  } else {
    state.hintShownAt = trainer.ply;
    board.setMarks([...state.baseMarks, [move.from, 'mark-hint']]);
    setStatus('info', 'Hint', 'Move the highlighted piece. Press again to see the move.');
  }
  renderPanel();
}

function renderPanel() {
  const { trainer } = state;
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
    $('stats-title').textContent = 'What people play at this level';
    box.replaceChildren(el('p', { class: 'muted' }, last ? 'Not enough games at this level in that position.' : 'Appears after the first move.'));
    return;
  }
  const games = rows.reduce((sum, row) => sum + row.games, 0).toLocaleString('en');
  $('stats-title').textContent = `Before ${last.san}, at this level`;
  box.replaceChildren(
    el('div', { class: 'stats-head' }, el('span', {}, 'Move'), el('span', {}, 'Played by'), el('span', {}, 'Result')),
    ...topRowsWith(rows, last.san).map((row) => statRow(row, row.san === last.san)),
    el('p', { class: 'stats-foot' }, `${games} games · White / draw / Black`),
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
    el('span', { class: 'stats-move' }, row.san),
    el('span', { class: 'stats-share' },
      el('span', { class: 'share-track' }, el('span', { class: 'share-fill', style: `width:${row.share * 100}%` })),
      el('span', { class: 'share-value' }, percent(row.share))),
    el('span', { class: 'result-bar', role: 'img', 'aria-label': `White ${percent(row.white)}, draw ${percent(row.draws)}, Black ${percent(row.black)}` },
      segment('white', row.white), segment('draw', row.draws), segment('black', row.black)));
}

function finish() {
  const { trainer, board } = state;
  board.setMovable(null);
  const summary = trainer.summary();
  const headlines = {
    complete: summary.clean && state.mode === MODES.PRACTICE ? 'Perfect line!' : 'Line complete',
    gameOver: 'The game is over',
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
    ? 'Once it feels familiar, switch to Practice to track your progress.'
    : scoreText(summary.answered, summary.mistakes, summary.hints);
  $('finish-mastery').textContent = `${state.opening.name}: ${percent(state.progress.mastery(state.opening.id, positionsOf(state.opening)))} mastered`;
  $('analysis-link').href = `https://lichess.org/analysis/${trainer.fen.replace(/ /g, '_')}`;
  $('share').textContent = 'Share';
  $('finish-card').hidden = false;
  $('session-actions').hidden = true;
}

async function shareResult() {
  const { opponent } = state.trainer;
  const summary = state.trainer.summary();
  const outcome = summary.clean ? 'a perfect line' : `a line with ${count(summary.mistakes, 'mistake', 'mistakes')}`;
  const text = `I played ${outcome} of the ${state.opening.name} against a ${opponentLabel(opponent)} opponent on ChessGym`;
  const url = `${SITE_URL}#${state.opening.id}`;
  try {
    if (navigator.share) {
      await navigator.share({ text, url });
    } else {
      await navigator.clipboard.writeText(`${text}: ${url}`);
      $('share').textContent = 'Copied!';
    }
  } catch {
    // The person cancelled the share sheet or clipboard access is blocked.
  }
}

function exitTraining() {
  state.generation += 1;
  $('training').hidden = true;
  $('setup').hidden = false;
  renderSetup();
}

/* ---------- Startup ---------- */

function applyDeepLink() {
  const id = decodeURIComponent(location.hash.slice(1));
  const opening = state.data.openings.find((item) => item.id === id);
  if (!opening) return;
  state.color = opening.color;
  state.firstMove = opening.color === 'black' ? firstMoveOf(opening) : ALL;
  state.style = ALL;
  state.openingId = opening.id;
}

async function main() {
  try {
    const [data, meta] = await Promise.all([loadOpenings(), loadMeta()]);
    state.data = data;
    state.meta = meta;
  } catch (error) {
    $('setup-error').textContent = `${error.message}.`;
    return;
  }
  $('stat-openings').textContent = formatCount(state.data.openings.length);
  $('stat-lines').textContent = formatCount(state.data.openings.reduce((sum, opening) => sum + opening.lines.length, 0));
  $('stat-games').textContent = `${(state.meta.games / 1e6).toFixed(1)}M`;

  const saved = state.progress.settings;
  for (const key of ['color', 'firstMove', 'rating', 'scale', 'level', 'mode', 'plies', 'adaptive', 'openingId']) {
    if (saved[key] !== undefined) state[key] = saved[key];
  }
  applyDeepLink();
  renderSetup();

  $('start').addEventListener('click', startTraining);
  $('surprise').addEventListener('click', surpriseMe);
  $('search').addEventListener('input', (event) => {
    state.search = event.target.value;
    renderOpeningGrid();
    renderStartBar();
  });
  const setRating = (value) => {
    if (!Number.isFinite(value) || value < MIN_RATING || value > MAX_RATING) return;
    state.rating = value;
    renderRatingSummary();
    renderStartBar();
  };
  $('rating-input').addEventListener('input', (event) => {
    setRating(Number(event.target.value));
    $('rating-slider').value = state.rating;
  });
  $('rating-input').addEventListener('blur', () => { $('rating-input').value = state.rating; });
  $('rating-slider').addEventListener('input', (event) => {
    setRating(Number(event.target.value));
    $('rating-input').value = state.rating;
  });
  $('adaptive').addEventListener('change', (event) => { state.adaptive = event.target.checked; });
  $('hint').addEventListener('click', requestHint);
  $('restart').addEventListener('click', newSession);
  $('next-line').addEventListener('click', newSession);
  $('share').addEventListener('click', shareResult);
  $('back').addEventListener('click', exitTraining);
  $('back-setup').addEventListener('click', exitTraining);
  $('reset-progress').addEventListener('click', () => {
    if (window.confirm('Delete all the progress saved in this browser?')) {
      state.progress.reset();
      renderSetup();
    }
  });
  window.addEventListener('hashchange', () => {
    applyDeepLink();
    if ($('training').hidden) renderSetup();
  });
}

function formatCount(value) {
  return value.toLocaleString('en');
}

main();
