import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { applyTheme, loadThemePref, resolveTheme } from './settings';
import './style.css';

/* index.html のインライン script と二重だが、script 無効環境などの保険として起動時にも確定させる */
applyTheme(resolveTheme(loadThemePref()));
/* auto のときだけ OS の配色変更に追随する(固定した設定は動かさない) */
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  const pref = loadThemePref();
  if (pref === 'auto') applyTheme(resolveTheme(pref));
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
