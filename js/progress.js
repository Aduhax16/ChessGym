// Progress saved in the browser. Storage may be unavailable (private windows),
// in which case progress simply lasts until the page is closed.

const STORAGE_KEY = 'chessgym/v1';

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
  }

  _save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch {
      // Not persisted; keep working from memory.
    }
  }

  record(openingId, key, firstTry) {
    const positions = (this.data.positions[openingId] ??= {});
    const entry = (positions[key] ??= { ok: 0, fail: 0, streak: 0 });
    if (firstTry) {
      entry.ok += 1;
      entry.streak += 1;
    } else {
      entry.fail += 1;
      entry.streak = 0;
    }
    this._save();
  }

  streak(openingId, key) {
    return this.data.positions[openingId]?.[key]?.streak ?? 0;
  }

  /** Share of the given positions answered right twice in a row. */
  mastery(openingId, keys) {
    if (!keys.length) return 0;
    return keys.filter((key) => this.streak(openingId, key) >= 2).length / keys.length;
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
