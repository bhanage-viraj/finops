import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { clearAllDocuments, fetchSettings, setExpenseExport, startZohoConnect } from '../api/admin.js';
import { fetchStats } from '../api/documents.js';
import { useAuth } from '../auth/AuthContext.jsx';
import UploadDropzone from '../components/UploadDropzone.jsx';

const CARDS = [
  ['total', 'Documents', '/documents'],
  ['awaiting', 'Awaiting', '/documents?status=uploaded'],
  ['processing', 'Processing', '/documents?status=processing'],
  ['review', 'Needs review', '/documents?needsReview=1'],
  ['approved', 'Approved', '/documents?status=approved'],
  ['failed', 'Failed', '/documents?status=failed'],
];

const WORKFLOWS = [
  ['/documents', 'Documents', 'Review and approve expense receipts'],
  ['/payments', 'Payments', 'Match bank transfer screenshots'],
  ['/follow-up', 'Follow-up', 'Remind overdue customers'],
];

function ZohoConnect() {
  const [settings, setSettings] = useState(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function load() {
    return fetchSettings().then(setSettings).catch((err) => setError(err.message));
  }

  useEffect(() => {
    load();
  }, []);

  async function connect() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const body = await startZohoConnect();
      if (!body.url) throw new Error('Zoho did not return a sign-in link.');
      window.location.assign(body.url);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  async function toggleExport() {
    if (!settings) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const next = await setExpenseExport(!settings.erpFeaturesEnabled);
      setSettings(next);
      setMessage(next.erpFeaturesEnabled
        ? 'Expense export is on. An approved receipt can be sent to Zoho Books.'
        : 'Expense export is off. Nothing will be sent to Zoho Books.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function clearReceipts() {
    if (!window.confirm('Delete every receipt and its photo? This cannot be undone.')) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await clearAllDocuments();
      setMessage(`${result.documentsDeleted} receipt${result.documentsDeleted === 1 ? '' : 's'} deleted.`);
      window.location.reload();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const missing = settings?.zohoMissing || [];
  const connected = settings?.zohoConnected === true;
  const exportOn = settings?.erpFeaturesEnabled === true;

  return (
    <section className="card">
      <h2>Zoho Books</h2>
      <p className="hint">
        Connect once (expense create and overdue invoice read), then turn export on.
        After a scope change, choose Connect Zoho again. Approving a receipt still does not send it.
      </p>
      {settings && (
        <>
          <p className={connected ? 'message message-ok' : 'message message-warn'}>
            {connected ? 'Zoho is connected.' : 'Zoho is not connected yet.'}
          </p>
          <p className={exportOn ? 'message message-ok' : 'message message-warn'}>
            {exportOn ? 'Expense export is on.' : 'Expense export is off.'}
          </p>
          {missing.length > 0 && (
            <p className="message message-bad">Still needed on the live server: {missing.join(', ')}</p>
          )}
        </>
      )}
      {error && <p className="message message-bad">{error}</p>}
      {message && <p className="message message-ok">{message}</p>}
      <div className="actions">
        <button type="button" className="btn btn-primary" disabled={busy || missing.length > 0} onClick={connect}>
          {connected ? 'Connect Zoho again' : 'Connect Zoho'}
        </button>
        <button type="button" className="btn btn-secondary" disabled={busy || !settings} onClick={toggleExport}>
          {exportOn ? 'Turn expense export off' : 'Turn expense export on'}
        </button>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={clearReceipts}>
          Clear all receipts
        </button>
      </div>
    </section>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const [stats, setStats] = useState(null);
  const [error, setError] = useState('');
  const admin = user?.role === 'admin';

  useEffect(() => {
    fetchStats().then(setStats).catch((err) => setError(err.message));
  }, []);

  return (
    <>
      <div className="page-head">
        <h1>Overview</h1>
      </div>

      <UploadDropzone
        title="Scan expense receipt"
        hint="Photograph a fuel slip, supplier receipt, or work order. Bank transfers go to Payments."
      />

      {error && <p className="message message-bad">{error}</p>}

      <h2 className="section-title">Receipt status</h2>
      <div className="stat-grid">
        {CARDS.map(([key, label, to]) => (
          <Link key={key} to={to} className="card stat-card">
            <p className="eyebrow">{label}</p>
            <p className="stat-number">{stats ? stats[key] : '—'}</p>
          </Link>
        ))}
      </div>

      <h2 className="section-title">Go to</h2>
      <div className="workflow-grid">
        {WORKFLOWS.map(([to, label, text]) => (
          <Link key={to} to={to} className="card workflow-card">
            <strong>{label}</strong>
            <p className="hint">{text}</p>
          </Link>
        ))}
      </div>

      {admin && <ZohoConnect />}
    </>
  );
}
