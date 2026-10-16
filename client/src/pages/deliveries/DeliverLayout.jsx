import { Link, NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext.jsx';

export default function DeliverLayout() {
  const { user, signOut } = useAuth();
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <p className="brand">Deliver</p>
        <nav className="nav" aria-label="Deliveries">
          <NavLink to="/deliver" end className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
            Days
          </NavLink>
        </nav>
      </aside>
      <div className="workspace">
        <header className="phone-bar">
          <div className="phone-bar-top">
            <strong>Deliver</strong>
            <button type="button" className="btn btn-secondary" onClick={signOut}>Sign out</button>
          </div>
          <nav className="nav" aria-label="Deliveries mobile">
            <NavLink to="/deliver" end className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
              Days
            </NavLink>
          </nav>
        </header>
        <div className="topbar">
          <span>{user?.name} · {user?.role}</span>
          <div className="row gap">
            {user?.role !== 'delivery' && (
              <Link className="btn btn-secondary" to="/">FinOps</Link>
            )}
            <button type="button" className="btn btn-secondary" onClick={signOut}>Sign out</button>
          </div>
        </div>
        <div className="content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
