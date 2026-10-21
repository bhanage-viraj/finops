import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchSettings, setExpenseExport, startZohoConnect } from '../api/admin.js';
import { useAuth } from '../auth/AuthContext.jsx';

const FEATURES = [
  ['/documents', 'Documents', 'Scan and approve expense receipts'],
  ['/payments', 'Payments', 'Match bank transfer screenshots'],
  ['/follow-up', 'Follow-up', 'Remind overdue customers'],
  ['/deliver', 'Deliver', 'Routes, maps, Cartrack (read-only), receipt check'],
];

function ZohoConnect() {
  const [settings, setSettings] = useState(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchSettings()
      .then(setSettings)
      .catch((err) => setError(err.message));
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
        ? 'Zoho features are on (expenses, payments, follow-up).'
        : 'Zoho features are off.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const connectMissing = settings?.zohoConnectMissing || [];
  const workMissing = settings?.zohoMissing || [];
  const connected = settings?.zohoConnected === true;
  const exportOn = settings?.erpFeaturesEnabled === true;
  const canConnect = connectMissing.length === 0;

  return (
    <section className="card">
      <h2>Zoho Books</h2>
      <p className="hint">
        Connect Zoho once, then turn features on. Approving a receipt still does not send it until you choose Send.
      </p>

      {!settings && !error && <p className="hint">Checking Zoho…</p>}

      {settings && (
        <>
          <p className={connected ? 'message message-ok' : 'message message-warn'}>
            {connected ? 'Connected.' : 'Not connected yet.'}
          </p>
          <p className={exportOn ? 'message message-ok' : 'message message-warn'}>
            {exportOn ? 'Features on.' : 'Features off.'}
          </p>
          {!canConnect && (
            <p className="message message-bad">
              Set on the server before Connect: {connectMissing.join(', ')}
            </p>
          )}
          {canConnect && workMissing.length > 0 && (
            <p className="message message-warn">
              Also set for full Zoho use: {workMissing.join(', ')}
            </p>
          )}
        </>
      )}

      {error && <p className="message message-bad">{error}</p>}
      {message && <p className="message message-ok">{message}</p>}

      <div className="actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !settings || !canConnect}
          onClick={connect}
        >
          {connected ? 'Connect Zoho again' : 'Connect Zoho'}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy || !settings || !connected}
          onClick={toggleExport}
        >
          {exportOn ? 'Turn features off' : 'Turn features on'}
        </button>
      </div>
    </section>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const admin = user?.role === 'admin';

  return (
    <>
      <div className="page-head">
        <h1>Overview</h1>
      </div>

      <div className="overview-actions">
        {FEATURES.map(([to, label, text]) => (
          <Link key={to} to={to} className="btn btn-primary overview-feature-btn">
            <span>{label}</span>
            <span className="overview-feature-hint">{text}</span>
          </Link>
        ))}
      </div>

      {admin && <ZohoConnect />}
    </>
  );
}
