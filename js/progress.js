// Progress saved in the browser. Storage may be unavailable (private windows),
// in which case progress simply lasts until the page is closed.

const STORAGE_KEY = 'chessgym/v1';
const MAX_LEVEL = 2;

function read() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
  } catch {
    return {};
  }
}

export class Progress {
  constructor() {
    this.data = { positions: {}, sessions: {}, settings: {}, ...read() };
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

  get settings() { return this.data.settings; }

  saveSettings(settings) {
    this.data.settings = { ...this.data.settings, ...settings };
    this._save();
  }

  reset() {
    this.data = { positions: {}, sessions: {}, settings: this.data.settings };
    this._save();
  }
}
