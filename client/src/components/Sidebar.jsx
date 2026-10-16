import { NavLink } from 'react-router-dom';

const LINKS = [
  ['/', 'Overview'],
  ['/documents', 'Documents'],
  ['/payments', 'Payments'],
  ['/follow-up', 'Follow-up'],
  ['/deliver', 'Deliver'],
];

export default function Sidebar() {
  return (
    <nav className="nav" aria-label="Main">
      {LINKS.map(([to, label]) => (
        <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
          {label}
        </NavLink>
      ))}
    </nav>
  );
}
