// A small dependency-free chess board: click or drag to move, animated pieces,
// legal-move dots, highlights, hint arrows and right-click annotations.
// Knows nothing about training.

const FILES = 'abcdefgh';
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Hold Shift or Alt while right-dragging for a different annotation colour. */
function annotationColor(event) {
  if (event.shiftKey) return 'green';
  if (event.altKey) return 'red';
  return 'orange';
}

function isKnightJump(dx, dy) {
  return (Math.abs(dx) === 1 && Math.abs(dy) === 2) || (Math.abs(dx) === 2 && Math.abs(dy) === 1);
}

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
    this.annotations = { squares: new Map(), arrows: new Map() }; // keyed by square or "from-to"
    this.annotating = null;

    root.classList.add('board');
    root.innerHTML = '';
    this.squaresLayer = this._layer('board-squares');
    this.marksLayer = this._layer('board-marks');
    this.annotationLayer = this._layer('board-annotations');
    this.piecesLayer = this._layer('board-pieces');
    this.arrowLayer = document.createElementNS(SVG_NS, 'svg');
    this.arrowLayer.setAttribute('viewBox', '0 0 8 8');
    this.arrowLayer.classList.add('board-arrows');
    this.arrowLayer.setAttribute('aria-hidden', 'true');
    this.userArrows = document.createElementNS(SVG_NS, 'g');
    this.previewArrow = document.createElementNS(SVG_NS, 'g');
    this.hintArrow = document.createElementNS(SVG_NS, 'g');
    this.arrowLayer.append(this.userArrows, this.previewArrow, this.hintArrow);
    root.append(this.arrowLayer);
    this._drawSquares();

    root.addEventListener('pointerdown', (event) => this._down(event));
    root.addEventListener('pointermove', (event) => this._dragMove(event));
    root.addEventListener('pointerup', (event) => this._up(event));
    root.addEventListener('pointercancel', () => this._cancelDrag());
    root.addEventListener('contextmenu', (event) => event.preventDefault());
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
    this._drawAnnotations();
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
    this.clearAnnotations();
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

  showArrow(from, to, className = 'arrow-hint') {
    this.clearArrows();
    this._drawArrow(this.hintArrow, from, to, className);
  }

  clearArrows() {
    this.hintArrow.replaceChildren();
  }

  /** Draws an arrow, bent like an L when it follows a knight's jump. */
  _drawArrow(group, from, to, className) {
    const [x1, y1] = this._xy(from);
    const [x2, y2] = this._xy(to);
    const points = [[x1 + 0.5, y1 + 0.5]];
    if (isKnightJump(x2 - x1, y2 - y1)) {
      points.push(Math.abs(x2 - x1) > Math.abs(y2 - y1) ? [x2 + 0.5, y1 + 0.5] : [x1 + 0.5, y2 + 0.5]);
    }
    points.push([x2 + 0.5, y2 + 0.5]);

    const [tailX, tailY] = points[points.length - 2];
    const [endX, endY] = points[points.length - 1];
    const length = Math.hypot(endX - tailX, endY - tailY);
    const ux = (endX - tailX) / length;
    const uy = (endY - tailY) / length;
    const tipX = endX - ux * 0.08;
    const tipY = endY - uy * 0.08;
    const baseX = tipX - ux * 0.38;
    const baseY = tipY - uy * 0.38;

    const [startX, startY] = points[0];
    const [nextX, nextY] = points[1];
    const startLength = Math.hypot(nextX - startX, nextY - startY);
    points[0] = [startX + ((nextX - startX) / startLength) * 0.28, startY + ((nextY - startY) / startLength) * 0.28];
    points[points.length - 1] = [baseX, baseY];

    const arrow = document.createElementNS(SVG_NS, 'g');
    arrow.setAttribute('class', `arrow ${className}`);
    const line = document.createElementNS(SVG_NS, 'polyline');
    line.setAttribute('points', points.map((point) => point.join(',')).join(' '));
    const head = document.createElementNS(SVG_NS, 'polygon');
    const px = -uy * 0.23;
    const py = ux * 0.23;
    head.setAttribute('points', `${tipX},${tipY} ${baseX + px},${baseY + py} ${baseX - px},${baseY - py}`);
    arrow.append(line, head);
    group.append(arrow);
  }

  clearAnnotations() {
    this.annotations.squares.clear();
    this.annotations.arrows.clear();
    this._drawAnnotations();
  }

  _toggle(map, key, value) {
    if (map.get(key) === value) map.delete(key);
    else map.set(key, value);
  }

  _drawAnnotations() {
    this.annotationLayer.replaceChildren();
    for (const [square, color] of this.annotations.squares) {
      const mark = document.createElement('div');
      mark.className = `mark annotation-${color}`;
      this._place(mark, square);
      this.annotationLayer.append(mark);
    }
    this.userArrows.replaceChildren();
    for (const [key, color] of this.annotations.arrows) {
      const [from, to] = key.split('-');
      this._drawArrow(this.userArrows, from, to, `arrow-${color}`);
    }
  }

  _startAnnotation(event) {
    const square = this._squareAt(event);
    if (!square) return;
    event.preventDefault();
    this.annotating = { from: square, to: square, color: annotationColor(event) };
    this.root.setPointerCapture(event.pointerId);
  }

  _moveAnnotation(event) {
    const target = this._squareAt(event);
    if (!target || target === this.annotating.to) return;
    this.annotating.to = target;
    this.previewArrow.replaceChildren();
    if (target !== this.annotating.from) {
      this._drawArrow(this.previewArrow, this.annotating.from, target, `arrow-${this.annotating.color}`);
    }
  }

  _finishAnnotation() {
    const { from, to, color } = this.annotating;
    this.annotating = null;
    this.previewArrow.replaceChildren();
    if (from === to) this._toggle(this.annotations.squares, from, color);
    else this._toggle(this.annotations.arrows, `${from}-${to}`, color);
    this._drawAnnotations();
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
    // On a Mac, Ctrl+click is also a right click.
    if (event.button === 2 || (event.button === 0 && event.ctrlKey)) {
      this._startAnnotation(event);
      return;
    }
    if (event.button !== 0) return;
    this.clearAnnotations();
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
    if (this.annotating) {
      this._moveAnnotation(event);
      return;
    }
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
    if (this.annotating) {
      this._finishAnnotation();
      return;
    }
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
    this.annotating = null;
    this.previewArrow.replaceChildren();
    if (!this.drag) return;
    this.drag.el.classList.remove('is-dragging');
    this._place(this.drag.el, this.drag.square);
    this.drag = null;
    this._clearSelection();
  }
}
