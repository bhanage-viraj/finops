import { Navigate } from 'react-router-dom';
import { useAuth } from './AuthContext.jsx';

const ALLOWED = new Set(['delivery', 'admin', 'accountant']);

/** Protects /deliver — delivery team plus office admins/accountants. */
export default function DeliverRoute({ children }) {
  const { user, ready } = useAuth();
  if (!ready) return <p className="muted">Checking your session…</p>;
  if (!user) return <Navigate to="/deliver/login" replace />;
  if (!ALLOWED.has(user.role)) return <Navigate to="/" replace />;
  return children;
}
