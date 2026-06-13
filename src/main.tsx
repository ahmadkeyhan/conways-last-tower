import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { runEngineTest } from './engine';

// Console self-test only in local dev — never in the minted build.
if (import.meta.env.DEV) runEngineTest();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
