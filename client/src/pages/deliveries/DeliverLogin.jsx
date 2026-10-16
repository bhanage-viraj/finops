import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { login } from '../../api/auth.js';
import { useAuth } from '../../auth/AuthContext.jsx';

const DELIVER_ROLES = new Set(['delivery', 'admin', 'accountant']);

export default function DeliverLogin() {
  const { user, signIn } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (user && DELIVER_ROLES.has(user.role)) return <Navigate to="/deliver" replace />;
  if (user) return <Navigate to="/" replace />;

  async function onSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await login(email, password);
      if (!DELIVER_ROLES.has(result.user?.role)) {
        setError('This login is for the delivery team. Office staff should use the FinOps sign-in.');
        return;
      }
      signIn(result.user, result.token);
      navigate('/deliver');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-screen">
      <form className="card login-card" onSubmit={onSubmit}>
        <p className="eyebrow">JAAN Deliveries</p>
        <h1>Delivery sign in</h1>
        <p className="hint">Separate from FinOps. Drivers and delivery admins only.</p>
        <label className="field">
          <span className="field-label">Email</span>
          <input
            type="email"
            value={email}
            autoComplete="username"
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>
        <label className="field">
          <span className="field-label">Password</span>
          <input
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        {error && <p className="message message-bad">{error}</p>}
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="hint" style={{ marginTop: 12 }}>
          <a href="/login">FinOps office sign-in</a>
        </p>
      </form>
    </main>
  );
}
