// The game review screen: summary, step-by-step moves, best move arrow, evaluation
// bar and graph. It only draws what js/review.js worked out.
import { Chess } from '../vendor/chess.js';
import { CLASSES, ERROR_CLASSES, formatEval, winChance } from './review.js';

const LINE_STEP_MS = 900;
const SVG_NS = 'http://www.w3.org/2000/svg';
const GRAPH_HEIGHT = 84;
const GRAPH_PAD = 8;
const GRAPH_MARKED = ['mistake', 'blunder'];

const $ = (id) => document.getElementById(id);

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function svg(tag, attributes) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}

function badge(grade) {
  const chip = node('span', `grade-badge grade-${grade}`, CLASSES[grade].glyph);
  chip.setAttribute('aria-hidden', 'true');
  return chip;
}

const moveName = (ply) => `${ply.number}${ply.color === 'w' ? '.' : '...'} ${ply.san}`;

export class ReviewPanel {
  constructor({ board, onClose, onRetry }) {
    Object.assign(this, { board, onClose, onRetry });
    this.review = null;
    this.index = 0; // 0 is the starting position, n is the position after move n
    this.isOpen = false;
    this.lineTimer = null;

    $('review-close').addEventListener('click', () => this.onClose());
    $('review-first').addEventListener('click', () => this.goTo(0));
    $('review-prev').addEventListener('click', () => this.goTo(this.index - 1));
    $('review-next').addEventListener('click', () => this.goTo(this.index + 1));
    $('review-last').addEventListener('click', () => this.goTo(this.review.plies.length));
    $('review-next-error').addEventListener('click', () => this.goToNextError());
    $('review-line').addEventListener('click', () => this.toggleLine());
    $('review-retry').addEventListener('click', () => this.onRetry());
    document.addEventListener('keydown', (event) => this._key(event));
    window.addEventListener('resize', () => {
      if (this.isOpen && this.review) this._renderGraph();
    });
  }

  /** Switches the side panel and the evaluation bar over to the review. */
  open(userColor, meta) {
    this.userColor = userColor;
    this.isOpen = true;
    $('review-meta').textContent = meta;
    $('review-panel').hidden = false;
    $('review-panel').closest('.panel').classList.add('is-reviewing');
    window.scrollTo(0, 0);
  }

  close() {
    this._stopLine();
    this.isOpen = false;
    $('review-panel').hidden = true;
    $('review-panel').closest('.panel').classList.remove('is-reviewing');
    $('eval-bar').hidden = true;
  }

  /** Forgets the game. The next open starts from the progress view. */
  reset() {
    this.review = null;
    this.index = 0;
  }

  showProgress(done, total) {
    $('review-error').hidden = true;
    $('review-content').hidden = true;
    $('review-progress').hidden = false;
    $('review-progress-text').textContent = done
      ? `Analysing position ${done} of ${total}…`
      : 'Loading the engine…';
    $('review-progress-fill').style.width = `${total ? (done / total) * 100 : 0}%`;
  }

  showError(message) {
    $('review-progress').hidden = true;
    $('review-content').hidden = true;
    $('review-error').hidden = false;
    $('review-error-text').textContent = message;
  }

  /** Draws a finished analysis and goes to the start of the game. */
  show(review) {
    this.review = review;
    $('review-progress').hidden = true;
    $('review-error').hidden = true;
    $('review-content').hidden = false;
    $('eval-bar').hidden = false;
    this._renderSummary();
    this._renderMoves();
    this._renderGraph();
    this.goTo(this.index);
  }

  goTo(index) {
    if (!this.review) return;
    this._stopLine();
    this.index = Math.max(0, Math.min(this.review.plies.length, index));
    this._renderPosition();
  }

  goToNextError() {
    const { plies } = this.review;
    const isUserError = (ply) => ply.color === this.userColor && ERROR_CLASSES.includes(ply.grade);
    const later = plies.findIndex((ply, at) => at >= this.index && isUserError(ply));
    const target = later >= 0 ? later : plies.findIndex(isUserError);
    if (target >= 0) this.goTo(target + 1);
  }

  /** Plays the engine's line on the board, from the position before the current move. */
  toggleLine() {
    if (this.lineTimer !== null) {
      this.goTo(this.index);
      return;
    }
    const ply = this.review.plies[this.index - 1];
    if (!ply?.lineUci.length) return;
    const chess = new Chess(ply.fenBefore);
    const steps = [...ply.lineUci];
    this.board.clearArrows();
    this.board.setMarks([]);
    this.board.setPosition(ply.fenBefore);
    $('review-line').textContent = 'Stop';
    const step = () => {
      const uci = steps.shift();
      if (!uci) {
        this.lineTimer = setTimeout(() => this.goTo(this.index), LINE_STEP_MS * 2);
        return;
      }
      const move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      this.board.setPosition(chess.fen());
      this.board.setMarks([[move.from, 'mark-review-line'], [move.to, 'mark-review-line']]);
      this.lineTimer = setTimeout(step, LINE_STEP_MS);
    };
    this.lineTimer = setTimeout(step, LINE_STEP_MS / 2);
  }

  _stopLine() {
    clearTimeout(this.lineTimer);
    this.lineTimer = null;
    $('review-line').textContent = 'Play the best line';
  }

  _key(event) {
    if (!this.isOpen || !this.review || event.target.closest?.('input, select, textarea, dialog')) return;
    const moves = { ArrowLeft: this.index - 1, ArrowRight: this.index + 1, Home: 0, End: this.review.plies.length };
    if (moves[event.key] === undefined) return;
    event.preventDefault();
    this.goTo(moves[event.key]);
  }

  _renderSummary() {
    const { players } = this.review;
    const opponent = this.userColor === 'w' ? 'b' : 'w';
    const columns = [players[this.userColor], players[opponent]];
    const grid = node('div', 'review-grid');
    grid.append(node('span'), node('span', 'review-player', 'You'), node('span', 'review-player', 'Opponent'));
    grid.append(node('span', 'review-row-label', 'Accuracy'));
    for (const { accuracy } of columns) {
      grid.append(node('strong', 'review-accuracy', accuracy === null ? '–' : `${accuracy.toFixed(1)}%`));
    }
    for (const [grade, { label }] of Object.entries(CLASSES)) {
      const name = node('span', 'review-row-label');
      name.append(badge(grade), label);
      grid.append(name);
      for (const { counts } of columns) grid.append(node('span', 'review-count', String(counts[grade])));
    }
    $('review-summary').replaceChildren(grid);
  }

  _renderMoves() {
    const { plies } = this.review;
    const rows = [];
    for (let at = 0; at < plies.length; at += 2) {
      const row = node('li');
      row.append(node('span', 'move-num', `${plies[at].number}.`));
      row.append(this._moveButton(plies[at], at + 1));
      if (plies[at + 1]) row.append(this._moveButton(plies[at + 1], at + 2));
      rows.push(row);
    }
    $('review-moves').replaceChildren(...rows);
  }

  _moveButton(ply, index) {
    const button = node('button', 'review-move-button');
    button.type = 'button';
    button.dataset.index = index;
    button.setAttribute('aria-label', `${moveName(ply)}, ${CLASSES[ply.grade].label}`);
    button.append(ply.san);
    if (ERROR_CLASSES.includes(ply.grade) || ply.grade === 'best') button.append(badge(ply.grade));
    button.addEventListener('click', () => this.goTo(index));
    return button;
  }

  _renderPosition() {
    const { plies, start } = this.review;
    const ply = plies[this.index - 1] ?? null;
    this.board.setPosition(ply ? ply.fenAfter : start.fen);
    this.board.clearArrows();
    if (ply) {
      this.board.setMarks([
        [ply.from, `mark-review mark-review-${ply.grade}`],
        [ply.to, `mark-review mark-review-${ply.grade} mark-badge`],
      ]);
      if (ply.best) this.board.showArrow(ply.best.from, ply.best.to, 'arrow-green');
    } else {
      this.board.setMarks([]);
    }
    this._renderEvalBar(ply ? ply.evaluation : start.evaluation);
    this._renderMoveCard(ply);
    this._markCurrent();
    this._renderGraphCursor();

    $('review-first').disabled = this.index === 0;
    $('review-prev').disabled = this.index === 0;
    $('review-next').disabled = this.index === plies.length;
    $('review-last').disabled = this.index === plies.length;
    $('review-next-error').disabled = !plies.some((item) => item.color === this.userColor && ERROR_CLASSES.includes(item.grade));
    $('review-line').disabled = !ply?.lineUci.length;
  }

  _renderMoveCard(ply) {
    const card = $('review-move');
    if (!ply) {
      const start = node('p', 'review-move-title', 'Starting position');
      card.replaceChildren(start, node('p', 'review-move-detail', 'Step through the game with the buttons below or the arrow keys.'));
      return;
    }
    const title = node('p', 'review-move-title');
    title.append(badge(ply.grade), `${moveName(ply)} · ${CLASSES[ply.grade].label}`);
    const who = ply.color === this.userColor ? 'Your' : 'Their';
    const details = [node('p', 'review-move-detail',
      `${who} expected score: ${Math.round(ply.chanceBefore)}% → ${Math.round(ply.chanceAfter)}%.`)];
    if (ply.best) {
      const best = node('p', 'review-move-best');
      best.append('Best was ', node('strong', '', ply.best.san));
      if (ply.line.length > 1) best.append(node('span', 'review-line-text', ply.line.join(' ')));
      details.push(best);
    } else {
      details.push(node('p', 'review-move-detail', ply.line.length > 1
        ? `The engine's top choice. It expects ${ply.line.slice(1).join(' ')}.`
        : 'The engine\'s top choice.'));
    }
    card.replaceChildren(title, ...details);
  }

  _renderEvalBar(evaluation) {
    const bar = $('eval-bar');
    bar.classList.toggle('is-flipped', this.board.orientation === 'b');
    bar.classList.toggle('black-leads', winChance(evaluation) < 50);
    $('eval-fill').style.height = `${winChance(evaluation)}%`;
    $('eval-text').textContent = formatEval(evaluation, 1); // the bar is too narrow for two decimals
  }

  _markCurrent() {
    const list = $('review-moves');
    let current = null;
    for (const button of list.querySelectorAll('button')) {
      const isCurrent = Number(button.dataset.index) === this.index;
      button.classList.toggle('is-current', isCurrent);
      if (isCurrent) current = button;
      if (isCurrent) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    }
    if (current) {
      const row = current.closest('li');
      list.scrollTop = Math.max(0, row.offsetTop - list.offsetTop - list.clientHeight / 2);
    } else {
      list.scrollTop = 0;
    }
  }

  _graphX(index, width) {
    return GRAPH_PAD + (index / Math.max(1, this.review.plies.length)) * (width - GRAPH_PAD * 2);
  }

  _graphY(chance) {
    return GRAPH_PAD + (1 - chance / 100) * (GRAPH_HEIGHT - GRAPH_PAD * 2);
  }

  _renderGraph() {
    const box = $('review-graph');
    const width = box.clientWidth;
    if (!width) return;
    const { plies, start } = this.review;
    const evaluations = [start.evaluation, ...plies.map((ply) => ply.evaluation)];
    const points = evaluations.map((evaluation, index) => [this._graphX(index, width), this._graphY(winChance(evaluation))]);
    const path = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const bottom = GRAPH_HEIGHT - GRAPH_PAD;
    const chart = svg('svg', { viewBox: `0 0 ${width} ${GRAPH_HEIGHT}`, width, height: GRAPH_HEIGHT, class: 'review-graph-svg', 'aria-hidden': 'true' });
    chart.append(svg('polygon', {
      class: 'graph-area',
      points: `${points[0][0]},${bottom} ${path} ${points[points.length - 1][0]},${bottom}`,
    }));
    chart.append(svg('line', { class: 'graph-mid', x1: GRAPH_PAD, x2: width - GRAPH_PAD, y1: this._graphY(50), y2: this._graphY(50) }));
    chart.append(svg('polyline', { class: 'graph-line', points: path }));
    this.graphCursor = svg('line', { class: 'graph-cursor', y1: GRAPH_PAD, y2: bottom });
    this.graphHover = svg('line', { class: 'graph-hover', y1: GRAPH_PAD, y2: bottom, visibility: 'hidden' });
    chart.append(this.graphCursor, this.graphHover);
    plies.forEach((ply, at) => {
      if (!GRAPH_MARKED.includes(ply.grade)) return;
      const [x, y] = points[at + 1];
      chart.append(svg('circle', { class: `graph-marker grade-${ply.grade}`, cx: x, cy: y, r: 4 }));
    });

    const tip = node('div', 'graph-tip');
    tip.hidden = true;
    const nearest = (event) => {
      const rect = chart.getBoundingClientRect();
      const share = (event.clientX - rect.left - GRAPH_PAD) / (width - GRAPH_PAD * 2);
      return Math.max(0, Math.min(plies.length, Math.round(share * plies.length)));
    };
    chart.addEventListener('pointermove', (event) => {
      const index = nearest(event);
      const x = this._graphX(index, width);
      this.graphHover.setAttribute('x1', x);
      this.graphHover.setAttribute('x2', x);
      this.graphHover.setAttribute('visibility', 'visible');
      const ply = plies[index - 1];
      tip.replaceChildren(
        node('strong', '', formatEval(evaluations[index])),
        ` ${ply ? `${moveName(ply)} · ${CLASSES[ply.grade].label}` : 'Start'}`,
      );
      tip.hidden = false;
      tip.style.left = `${Math.max(0, Math.min(width - tip.offsetWidth, x - tip.offsetWidth / 2))}px`;
    });
    chart.addEventListener('pointerleave', () => {
      tip.hidden = true;
      this.graphHover.setAttribute('visibility', 'hidden');
    });
    chart.addEventListener('click', (event) => this.goTo(nearest(event)));
    box.replaceChildren(chart, tip);
    this._renderGraphCursor();
  }

  _renderGraphCursor() {
    if (!this.graphCursor) return;
    const x = this._graphX(this.index, $('review-graph').clientWidth);
    this.graphCursor.setAttribute('x1', x);
    this.graphCursor.setAttribute('x2', x);
  }
}
