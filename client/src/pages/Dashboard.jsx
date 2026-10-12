import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchStats } from '../api/documents.js';

const CARDS = [
  ['total', 'Documents', '/documents'],
  ['awaiting', 'Awaiting', '/documents?status=uploaded'],
  ['processing', 'Processing', '/documents?status=processing'],
  ['review', 'Needs review', '/documents?needsReview=1'],
  ['approved', 'Approved', '/documents?status=approved'],
  ['failed', 'Failed', '/documents?status=failed'],
];

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchStats().then(setStats).catch((err) => setError(err.message));
  }, []);

  return (
    <>
      <h1>Overview</h1>
      {error && <p className="message message-bad">{error}</p>}
      <div className="stat-grid">
        {CARDS.map(([key, label, to]) => (
          <Link key={key} to={to} className="card stat-card">
            <p className="eyebrow">{label}</p>
            <p className="stat-number">{stats ? stats[key] : '—'}</p>
          </Link>
        ))}
      </div>
    </>
  );
}
