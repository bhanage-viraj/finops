import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext.jsx';

/** One shared login. Delivery users are steered to /deliver. */
export default function ProtectedRoute({ children }) {
  const { user, ready } = useAuth();
  const location = useLocation();
  if (!ready) return <p className="muted">Checking your session…</p>;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role === 'delivery' && !location.pathname.startsWith('/deliver')) {
    return <Navigate to="/deliver" replace />;
  }
  return children;
}
