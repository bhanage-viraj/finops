import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { currentUser } from '../api/auth.js';
import { getToken, setToken } from '../api/client.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(!getToken());

  useEffect(() => {
    if (!getToken()) return undefined;
    let cancelled = false;
    currentUser()
      .then((body) => { if (!cancelled) setUser(body.user); })
      .catch(() => { if (!cancelled) setToken(''); })
      .finally(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, []);

  const value = useMemo(() => ({
    user,
    ready,
    signIn(nextUser, token) {
      setToken(token);
      setUser(nextUser);
    },
    signOut() {
      setToken('');
      setUser(null);
    },
  }), [user, ready]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
