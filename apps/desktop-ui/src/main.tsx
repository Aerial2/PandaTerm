import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles.css';

const params = new URLSearchParams(window.location.search);
const windowMode = params.get('mode');
const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);

async function bootstrap() {
  if (windowMode === 'connection') {
    const { ConnectionWindow } = await import('./ConnectionWindow');
    root.render(<ConnectionWindow />);
    return;
  }

  if (windowMode === 'ai-settings') {
    const { AiSettingsWindow } = await import('./AiSettingsWindow');
    root.render(<AiSettingsWindow />);
    return;
  }

  const { default: App } = await import('./App');
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );

  // Wait for the first render so the main window does not flash white.
  requestAnimationFrame(() => {
    import('@tauri-apps/api/webviewWindow').then(({ getCurrentWebviewWindow }) => {
      const win = getCurrentWebviewWindow();
      void win.center().then(() => win.show());
    }).catch((e) => console.warn('Failed to show main window:', e));
  });
}

void bootstrap();