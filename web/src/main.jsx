import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import App from './App.jsx';
import { theme } from './theme.js';
import { AuthProvider } from './auth/AuthContext.jsx';
import { NotifyProvider } from './components/Notify.jsx';
import BrandedTheme from './components/BrandedTheme.jsx';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider theme={theme}>
      <BrowserRouter>
        <NotifyProvider>
          <AuthProvider>
            <BrandedTheme>
              <App />
            </BrandedTheme>
          </AuthProvider>
        </NotifyProvider>
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>,
);
