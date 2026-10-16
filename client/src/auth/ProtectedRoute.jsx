import { Navigate } from 'react-router-dom';
import { useAuth } from './AuthContext.jsx';

/** FinOps office shell — delivery-only users go to /deliver instead. */
export default function ProtectedRoute({ children }) {
  const { user, ready } = useAuth();
  if (!ready) return <p className="muted">Checking your session…</p>;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role === 'delivery') return <Navigate to="/deliver" replace />;
  return children;
}
