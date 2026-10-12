import { NavLink } from 'react-router-dom';

const LINKS = [
  ['/', 'Overview'],
  ['/documents', 'Documents'],
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
