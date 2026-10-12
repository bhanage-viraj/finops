import { Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import Sidebar from './Sidebar.jsx';

export default function Layout() {
  const { user, signOut } = useAuth();
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <p className="brand">FinOps</p>
        <Sidebar />
      </aside>
      <div className="workspace">
        <header className="phone-bar">
          <div className="phone-bar-top">
            <strong>FinOps</strong>
            <button type="button" className="btn btn-secondary" onClick={signOut}>Sign out</button>
          </div>
          <Sidebar />
        </header>
        <div className="topbar">
          <span>{user?.name} · {user?.role}</span>
          <button type="button" className="btn btn-secondary" onClick={signOut}>Sign out</button>
        </div>
        <div className="content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
