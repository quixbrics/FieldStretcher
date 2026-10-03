import './styles/tokens.css';
import './styles/app.css';
import { Engine } from './audio/engine';
import { mountApp, restoreQuality } from './ui/app';

const engine = new Engine();
restoreQuality(engine);
mountApp(document.getElementById('app')!, engine);

// ?debug exposes the engine on window.__fs (for poking at it from the console)
if (new URLSearchParams(location.search).has('debug')) (window as unknown as { __fs: Engine }).__fs = engine;

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
}
