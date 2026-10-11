import { createRoot } from 'react-dom/client';
import './i18n';
import App from './App';
import './styles.css';
import { ThemeProvider } from './theme';

createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>,
);
