// A small dependency-free chess board: click or drag to move, animated pieces,
// legal-move dots, highlights and arrows. Knows nothing about training.

const FILES = 'abcdefgh';
const SVG_NS = 'http://www.w3.org/2000/svg';

function parsePlacement(fen) {
  const pieces = new Map();
  fen.split(' ')[0].split('/').forEach((row, rowIndex) => {
    let file = 0;
    for (const char of row) {
      if (/\d/.test(char)) {
        file += Number(char);
      } else {
        const color = char === char.toUpperCase() ? 'w' : 'b';
        pieces.set(`${FILES[file]}${8 - rowIndex}`, `${color}${char.toLowerCase()}`);
        file += 1;
      }
    }
  });
  return pieces;
}

export class Board {
  constructor(root, { onMove }) {
    this.root = root;
    this.onMove = onMove;
    this.orientation = 'w';
    this.pieceEls = new Map(); // square -> element
    this.selected = null;
    this.dests = [];
    this.destsFor = null;
    this.marks = new Map(); // square -> class
    this.drag = null;

    root.classList.add('board');
    root.innerHTML = '';
    this.squaresLayer = this._layer('board-squares');
    this.marksLayer = this._layer('board-marks');
    this.piecesLayer = this._layer('board-pieces');
    this.arrowLayer = document.createElementNS(SVG_NS, 'svg');
    this.arrowLayer.setAttribute('viewBox', '0 0 8 8');
    this.arrowLayer.classList.add('board-arrows');
    this.arrowLayer.setAttribute('aria-hidden', 'true');
    root.append(this.arrowLayer);
    this._drawSquares();

    root.addEventListener('pointerdown', (event) => this._down(event));
    root.addEventListener('pointermove', (event) => this._dragMove(event));
    root.addEventListener('pointerup', (event) => this._up(event));
    root.addEventListener('pointercancel', () => this._cancelDrag());
  }

  _layer(className) {
    const layer = document.createElement('div');
    layer.className = className;
    this.root.append(layer);
    return layer;
  }

  _xy(square) {
    const file = FILES.indexOf(square[0]);
    const rank = Number(square[1]) - 1;
    return this.orientation === 'w' ? [file, 7 - rank] : [7 - file, rank];
  }

  _squareAt(event) {
    const rect = this.root.getBoundingClientRect();
    const x = Math.floor(((event.clientX - rect.left) / rect.width) * 8);
    const y = Math.floor(((event.clientY - rect.top) / rect.height) * 8);
    if (x < 0 || x > 7 || y < 0 || y > 7) return null;
    return this.orientation === 'w' ? `${FILES[x]}${8 - y}` : `${FILES[7 - x]}${y + 1}`;
  }

  _place(el, square) {
    const [x, y] = this._xy(square);
    el.style.transform = `translate(${x * 100}%, ${y * 100}%)`;
  }

  _drawSquares() {
    this.squaresLayer.innerHTML = '';
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        const square = document.createElement('div');
        square.className = `sq ${(x + y) % 2 ? 'sq-dark' : 'sq-light'}`;
        const file = this.orientation === 'w' ? FILES[x] : FILES[7 - x];
        const rank = this.orientation === 'w' ? 8 - y : y + 1;
        if (y === 7) square.dataset.file = file;
        if (x === 0) square.dataset.rank = rank;
        this.squaresLayer.append(square);
      }
    }
  }

  setOrientation(color) {
    if (color === this.orientation) return;
    this.orientation = color;
    this._drawSquares();
    for (const [square, el] of this.pieceEls) this._place(el, square);
    this._drawMarks();
  }

  _makePiece(piece, square) {
    const el = document.createElement('div');
    el.className = 'piece';
    el.dataset.piece = piece;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 40 40');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `assets/pieces.svg#${piece}`);
    svg.append(use);
    el.append(svg);
    this._place(el, square);
    this.piecesLayer.append(el);
    return el;
  }

  /** Shows a position, sliding pieces that moved rather than redrawing them. */
  setPosition(fen) {
    const next = parsePlacement(fen);
    const leftover = new Map(this.pieceEls);
    const placed = new Map();
    const missing = [];

    for (const [square, piece] of next) {
      const el = leftover.get(square);
      if (el && el.dataset.piece === piece) {
        placed.set(square, el);
        leftover.delete(square);
      } else {
        missing.push([square, piece]);
      }
    }
    for (const [square, piece] of missing) {
      const from = [...leftover].find(([, el]) => el.dataset.piece === piece);
      if (from) {
        leftover.delete(from[0]);
        this._place(from[1], square);
        placed.set(square, from[1]);
      } else {
        placed.set(square, this._makePiece(piece, square));
      }
    }
    for (const el of leftover.values()) el.remove();
    this.pieceEls = placed;
    this.position = next;
    this._clearSelection();
  }

  /** `color` may move; `destsFor(square)` returns [{to, capture}]. Null disables input. */
  setMovable(color, destsFor) {
    this.movable = color;
    this.destsFor = destsFor;
    this.root.classList.toggle('is-movable', Boolean(color));
    this._clearSelection();
  }

  setMarks(marks) {
    this.marks = new Map(marks);
    this._drawMarks();
  }

  _drawMarks() {
    this.marksLayer.innerHTML = '';
    const add = (square, className) => {
      const mark = document.createElement('div');
      mark.className = `mark ${className}`;
      this._place(mark, square);
      this.marksLayer.append(mark);
    };
    for (const [square, className] of this.marks) add(square, className);
    if (this.selected) {
      add(this.selected, 'mark-selected');
      for (const dest of this.dests) add(dest.to, dest.capture ? 'mark-capture' : 'mark-dest');
    }
  }

  showArrow(from, to) {
    this.clearArrows();
    const [x1, y1] = this._xy(from);
    const [x2, y2] = this._xy(to);
    const length = Math.hypot(x2 - x1, y2 - y1);
    const ux = (x2 - x1) / length;
    const uy = (y2 - y1) / length;
    const startX = x1 + 0.5 + ux * 0.25;
    const startY = y1 + 0.5 + uy * 0.25;
    const tipX = x2 + 0.5 - ux * 0.08;
    const tipY = y2 + 0.5 - uy * 0.08;
    const baseX = tipX - ux * 0.42;
    const baseY = tipY - uy * 0.42;
    const line = document.createElementNS(SVG_NS, 'line');
    Object.entries({ x1: startX, y1: startY, x2: baseX, y2: baseY }).forEach(([k, v]) => line.setAttribute(k, v));
    const head = document.createElementNS(SVG_NS, 'polygon');
    const px = -uy * 0.26;
    const py = ux * 0.26;
    head.setAttribute('points', `${tipX},${tipY} ${baseX + px},${baseY + py} ${baseX - px},${baseY - py}`);
    this.arrowLayer.append(line, head);
  }

  clearArrows() {
    this.arrowLayer.innerHTML = '';
  }

  shake() {
    this.root.classList.remove('is-shaking');
    void this.root.offsetWidth;
    this.root.classList.add('is-shaking');
  }

  _clearSelection() {
    this.selected = null;
    this.dests = [];
    this._drawMarks();
  }

  _ownPiece(square) {
    return this.movable && this.position?.get(square)?.[0] === this.movable;
  }

  _select(square) {
    this.selected = square;
    this.dests = this.destsFor(square);
    this._drawMarks();
  }

  _tryMove(square) {
    if (!this.dests.some((dest) => dest.to === square)) return false;
    const from = this.selected;
    this._clearSelection();
    this.onMove(from, square);
    return true;
  }

  _down(event) {
    if (!this.movable) return;
    const square = this._squareAt(event);
    if (!square) return;
    event.preventDefault();
    if (this.selected && this._tryMove(square)) return;
    if (!this._ownPiece(square)) {
      this._clearSelection();
      return;
    }
    const wasSelected = this.selected === square;
    this._select(square);
    const el = this.pieceEls.get(square);
    this.drag = { square, el, wasSelected, moved: false, startX: event.clientX, startY: event.clientY };
    this.root.setPointerCapture(event.pointerId);
  }

  _dragMove(event) {
    if (!this.drag) return;
    const { el, startX, startY } = this.drag;
    if (!this.drag.moved && Math.hypot(event.clientX - startX, event.clientY - startY) < 4) return;
    this.drag.moved = true;
    const rect = this.root.getBoundingClientRect();
    const size = rect.width / 8;
    el.classList.add('is-dragging');
    const x = ((event.clientX - rect.left) / size - 0.5) * 100;
    const y = ((event.clientY - rect.top) / size - 0.5) * 100;
    el.style.transform = `translate(${x}%, ${y}%)`;
  }

  _up(event) {
    if (!this.drag) return;
    const { el, square, moved, wasSelected } = this.drag;
    this.drag = null;
    el.classList.remove('is-dragging');
    const target = this._squareAt(event);
    if (moved) {
      this._place(el, square);
      if (!(target && target !== square && this._tryMove(target))) this._clearSelection();
    } else if (wasSelected) {
      this._clearSelection();
    }
  }

  _cancelDrag() {
    if (!this.drag) return;
    this.drag.el.classList.remove('is-dragging');
    this._place(this.drag.el, this.drag.square);
    this.drag = null;
    this._clearSelection();
  }
}
