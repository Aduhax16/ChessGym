// Progress saved in the browser. Storage may be unavailable (private windows),
// in which case progress simply lasts until the page is closed.

const STORAGE_KEY = 'chessgym/v1';
const MAX_LEVEL = 2;
const DAY = 24 * 60 * 60 * 1000;
// Days until a line comes back after each clean run in a row, like flashcards.
const REVIEW_DAYS = [1, 3, 7, 16, 35, 75];
// A line counts as mastered after this many clean runs in a row, spread over weeks.
export const LINE_MASTERED = 4;

function read() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
  } catch {
    return {};
  }
}

export class Progress {
  constructor() {
    this.data = { positions: {}, sessions: {}, lines: {}, settings: {}, ...read() };
    // Saves from the first version kept a streak instead of a level.
    for (const positions of Object.values(this.data.positions)) {
      for (const entry of Object.values(positions)) {
        entry.level ??= Math.min(MAX_LEVEL, entry.streak ?? 0);
      }
    }
  }

  _save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch {
      // Not persisted; keep working from memory.
    }
  }

  /** Each position climbs to level 2 with right answers and drops a level on a miss. */
  record(openingId, key, firstTry) {
    const positions = (this.data.positions[openingId] ??= {});
    const entry = (positions[key] ??= { ok: 0, fail: 0, level: 0 });
    if (firstTry) {
      entry.ok += 1;
      entry.level = Math.min(MAX_LEVEL, entry.level + 1);
    } else {
      entry.fail += 1;
      entry.level = Math.max(0, entry.level - 1);
    }
    this._save();
  }

  level(openingId, key) {
    return this.data.positions[openingId]?.[key]?.level ?? 0;
  }

  /** Average progress over the given positions, from 0 to 1. */
  mastery(openingId, keys) {
    if (!keys.length) return 0;
    const earned = keys.reduce((sum, key) => sum + this.level(openingId, key), 0);
    return earned / (keys.length * MAX_LEVEL);
  }

  finish(openingId, clean) {
    const entry = (this.data.sessions[openingId] ??= { played: 0, clean: 0 });
    entry.played += 1;
    if (clean) entry.clean += 1;
    this._save();
  }

  played(openingId) {
    return this.data.sessions[openingId]?.played ?? 0;
  }

  /**
   * Schedules a line after a run to its end. Learning it makes it due at once, so the
   * next run is from memory. A clean run pushes it further away, a slip brings it back now.
   */
  finishLine(openingId, lineKey, mode, clean, now = Date.now()) {
    const lines = (this.data.lines[openingId] ??= {});
    const entry = (lines[lineKey] ??= { level: 0, due: now, ok: 0, fail: 0 });
    if (mode === 'practice') {
      if (clean) {
        entry.ok += 1;
        entry.due = now + REVIEW_DAYS[Math.min(entry.level, REVIEW_DAYS.length - 1)] * DAY;
        entry.level += 1;
      } else {
        entry.fail += 1;
        entry.level = 0;
        entry.due = now;
      }
    }
    entry.last = now;
    this._save();
  }

  /** 'new' (never played), 'due' (to practise now) or 'scheduled', with the line's entry. */
  lineStatus(openingId, lineKey, now = Date.now()) {
    const entry = this.data.lines[openingId]?.[lineKey];
    if (!entry) return { status: 'new', entry: null };
    return { status: entry.due <= now ? 'due' : 'scheduled', entry };
  }

  /**
   * Which line to play next: overdue ones first, then a new one, then whichever
   * comes back soonest. `skip` is avoided when there is another choice.
   */
  nextLine(openingId, lines, { skip = null, now = Date.now() } = {}) {
    const info = lines.map((line, index) => ({ line, index, ...this.lineStatus(openingId, line.moves, now) }));
    const choices = info.length > 1 ? info.filter((item) => item.line !== skip) : info;
    const due = choices.filter((item) => item.status === 'due').sort((a, b) => a.entry.due - b.entry.due);
    if (due.length) return due[0].line;
    const fresh = choices.find((item) => item.status === 'new');
    if (fresh) return fresh.line;
    return choices.sort((a, b) => a.entry.due - b.entry.due)[0]?.line ?? null;
  }

  /** How many of the lines are mastered and how many are due now. */
  lineCounts(openingId, lines, now = Date.now()) {
    let mastered = 0;
    let due = 0;
    for (const line of lines) {
      const { status, entry } = this.lineStatus(openingId, line.moves, now);
      if (status === 'due') due += 1;
      if (entry && entry.level >= LINE_MASTERED) mastered += 1;
    }
    return { mastered, due };
  }

  /** Asks the browser not to clear this storage when space runs low. */
  static keep() {
    navigator.storage?.persist?.().catch(() => {});
  }

  get settings() { return this.data.settings; }

  saveSettings(settings) {
    this.data.settings = { ...this.data.settings, ...settings };
    this._save();
  }

  reset() {
    this.data = { positions: {}, sessions: {}, lines: {}, settings: this.data.settings };
    this._save();
  }
}
