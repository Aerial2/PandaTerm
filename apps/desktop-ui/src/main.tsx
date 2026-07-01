import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ConnectionWindow } from './ConnectionWindow';
import './styles.css';

const params = new URLSearchParams(window.location.search);
const windowMode = params.get('mode');

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    {windowMode === 'connection' ? <ConnectionWindow /> : <App />}
  </React.StrictMode>,
);

// Show the main window after React renders to avoid white flash
if (windowMode !== 'connection') {
  // Use requestAnimationFrame to wait for the first render to complete
  requestAnimationFrame(() => {
    import('@tauri-apps/api/webviewWindow').then(({ getCurrentWebviewWindow }) => {
      const win = getCurrentWebviewWindow();
      void win.center().then(() => win.show());
    }).catch((e) => console.warn('Failed to show main window:', e));
  });
}