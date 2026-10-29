import { createContext, useCallback, useContext, useState } from 'react';
import { Snackbar } from '@mui/material';

const NotifyContext = createContext(() => {});

// Short confirmation messages (replaces the ?saved=1 and ?created=1 flags).
export function NotifyProvider({ children }) {
  const [msg, setMsg] = useState(null);
  const notify = useCallback((text) => setMsg({ text, key: Date.now() }), []);
  return (
    <NotifyContext.Provider value={notify}>
      {children}
      <Snackbar
        key={msg?.key}
        open={Boolean(msg)}
        message={msg?.text}
        autoHideDuration={3000}
        onClose={() => setMsg(null)}
      />
    </NotifyContext.Provider>
  );
}

export function useNotify() {
  return useContext(NotifyContext);
}
