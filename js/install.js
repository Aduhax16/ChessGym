// Makes the site installable: registers the offline worker and runs the
// "Install" button. Browsers without an install prompt get written steps.

const STEPS = {
  ios: ['In Safari, tap the Share button.', 'Choose "Add to Home Screen".', 'Tap "Add".'],
  android: ['In Chrome, open the menu (the three dots).', 'Choose "Add to Home screen" or "Install app".', 'Confirm.'],
  safari: ['In Safari, open the File menu.', 'Choose "Add to Dock".', 'Click "Add".'],
  other: ['Open this page in Chrome or Edge.', 'Click the install icon at the right of the address bar.', 'Click "Install".'],
};

function platform() {
  const agent = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(agent) || (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(agent)) return 'android';
  if (/Macintosh/.test(agent) && /Safari/.test(agent) && !/Chrome|Chromium|Edg|Firefox/.test(agent)) return 'safari';
  return 'other';
}

const isInstalled = () =>
  window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function setupInstallButton() {
  const button = document.getElementById('install-open');
  const sheet = document.getElementById('install');
  document.getElementById('install-close').addEventListener('click', () => sheet.close());
  if (isInstalled()) return;

  button.hidden = false;
  let prompt = null;

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    prompt = event;
  });
  window.addEventListener('appinstalled', () => {
    button.hidden = true;
    prompt = null;
  });

  button.addEventListener('click', async () => {
    if (prompt) {
      const pending = prompt;
      prompt = null;
      try {
        await pending.prompt();
        return;
      } catch (error) {
        console.warn('Install prompt failed:', error);
      }
    }
    const items = STEPS[platform()].map((text) => {
      const item = document.createElement('li');
      item.textContent = text;
      return item;
    });
    document.getElementById('install-steps').replaceChildren(...items);
    sheet.showModal();
  });
}

setupInstallButton();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((error) => {
      console.warn('Offline mode is unavailable:', error);
    });
  });
}
