import { NavLink } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';

const OFFICE_LINKS = [
  ['/', 'Overview'],
  ['/documents', 'Documents'],
  ['/payments', 'Payments'],
  ['/follow-up', 'Follow-up'],
  ['/deliver', 'Deliver'],
  ['/demand', 'Demand'],
];

const DELIVERY_LINKS = [
  ['/deliver', 'Deliver'],
  ['/demand', 'Demand'],
];

export default function Sidebar() {
  const { user } = useAuth();
  const links = user?.role === 'delivery' ? DELIVERY_LINKS : OFFICE_LINKS;
  return (
    <nav className="nav" aria-label="Main">
      {links.map(([to, label]) => (
        <NavLink key={to} to={to} end={to === '/' || to === '/deliver'} className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
          {label}
        </NavLink>
      ))}
    </nav>
  );
}
