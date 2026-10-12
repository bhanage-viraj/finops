import { Navigate } from 'react-router-dom';
import { useAuth } from './AuthContext.jsx';

export default function ProtectedRoute({ children }) {
  const { user, ready } = useAuth();
  if (!ready) return <p className="muted">Checking your session…</p>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}
