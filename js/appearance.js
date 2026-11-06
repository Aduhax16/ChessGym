// Look-and-feel preferences: board colours, coordinates, animation and theme.

export const BOARD_THEMES = [
  { id: 'ocean', label: 'Ocean', light: '#dee3e6', dark: '#8ca2ad' },
  { id: 'wood', label: 'Walnut', light: '#f0d9b5', dark: '#b58863' },
  { id: 'green', label: 'Tournament', light: '#ebecd0', dark: '#779556' },
  { id: 'graphite', label: 'Graphite', light: '#d6d6db', dark: '#85858c' },
  { id: 'midnight', label: 'Midnight', light: '#aeb6c4', dark: '#4f5b70' },
  { id: 'lavender', label: 'Lavender', light: '#e9e5f2', dark: '#9c90c0' },
  { id: 'rose', label: 'Rose', light: '#f4e6e3', dark: '#c0908c' },
  { id: 'sand', label: 'Sand', light: '#f4efe3', dark: '#c6b48f' },
];

const DEFAULTS = {
  board: 'ocean',
  customLight: '#e6e6e6',
  customDark: '#7a8b99',
  coordinates: true,
  animation: true,
  theme: 'system',
};

export class Appearance {
  constructor(progress) {
    this.progress = progress;
    this.prefs = { ...DEFAULTS, ...progress.settings.appearance };
    this.apply();
  }

  /** The colours in use, whether from a preset or chosen by hand. */
  get colors() {
    if (this.prefs.board === 'custom') return { light: this.prefs.customLight, dark: this.prefs.customDark };
    return BOARD_THEMES.find((theme) => theme.id === this.prefs.board) ?? BOARD_THEMES[0];
  }

  set(patch) {
    this.prefs = { ...this.prefs, ...patch };
    this.progress.saveSettings({ appearance: this.prefs });
    this.apply();
  }

  apply() {
    const root = document.documentElement;
    const { light, dark } = this.colors;
    root.style.setProperty('--sq-light', light);
    root.style.setProperty('--sq-dark', dark);
    root.classList.toggle('no-coordinates', !this.prefs.coordinates);
    root.classList.toggle('no-animation', !this.prefs.animation);
    if (this.prefs.theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = this.prefs.theme;
  }
}
