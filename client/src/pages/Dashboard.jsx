import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { fetchStats } from '../api/documents.js';
import { useAuth } from '../auth/AuthContext.jsx';

const CARDS = [
  ['total', 'Documents', '/documents'],
  ['awaiting', 'Awaiting', '/documents?status=uploaded'],
  ['processing', 'Processing', '/documents?status=processing'],
  ['review', 'Needs review', '/documents?needsReview=1'],
  ['approved', 'Approved', '/documents?status=approved'],
  ['failed', 'Failed', '/documents?status=failed'],
];

const EXPENSE_ROWS = [
  ['fuel_receipt', 'Fuel receipt'],
  ['supplier_receipt', 'Supplier receipt'],
  ['supplier_invoice', 'Supplier invoice'],
  ['expense_receipt', 'Expense receipt'],
];

function accountForm(rules) {
  const expense = [];
  const paid = [];
  for (const rule of rules || []) {
    if (rule.kind === 'expense') {
      expense.push({
        documentType: rule.documentType || 'fuel_receipt',
        key: rule.key || '',
        label: rule.label || '',
        accountId: rule.accountId || '',
      });
    }
    if (rule.kind === 'paid_through') {
      paid.push({ key: rule.key, accountId: rule.accountId || '', label: rule.label || '' });
    }
  }
  if (expense.length === 0) expense.push({ documentType: 'fuel_receipt', key: '', label: '', accountId: '' });
  if (paid.length === 0) paid.push({ key: 'default', accountId: '', label: '' });
  return { expense, paid };
}

function ZohoExpenses() {
  const { user } = useAuth();
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (user?.role !== 'admin') return undefined;
    api('/admin/settings').then((body) => {
      setSettings(body);
      setForm(accountForm(body.zohoAccountRules));
    }).catch((err) => setError(err.message));
    return undefined;
  }, [user?.role]);

  if (user?.role !== 'admin') return null;

  async function connect() {
    setError('');
    try {
      const body = await api('/auth/zoho/start');
      window.location.assign(body.url);
    } catch (err) {
      setError(err.message);
    }
  }

  function setExpense(index, field, value) {
    setForm((current) => ({
      ...current,
      expense: current.expense.map((row, rowIndex) => (rowIndex === index ? { ...row, [field]: value } : row)),
    }));
  }

  function setPaid(index, field, value) {
    setForm((current) => ({
      ...current,
      paid: current.paid.map((row, rowIndex) => (rowIndex === index ? { ...row, [field]: value } : row)),
    }));
  }

  async function saveAccounts() {
    setBusy(true);
    setError('');
    const rules = [];
    for (const row of form.expense) {
      if (!row.accountId.trim() && !row.key.trim() && !row.label.trim()) continue;
      rules.push({
        kind: 'expense',
        documentType: row.documentType,
        key: row.key.trim(),
        accountId: row.accountId.trim(),
        label: row.label.trim(),
      });
    }
    for (const row of form.paid) {
      if (!row.accountId.trim() && !row.key.trim()) continue;
      rules.push({ kind: 'paid_through', key: row.key.trim(), accountId: row.accountId.trim(), label: row.label.trim() });
    }
    try {
      const next = await api('/admin/settings/accounts', { method: 'PUT', json: { rules } });
      setSettings(next);
      setForm(accountForm(next.zohoAccountRules));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function toggle() {
    setBusy(true);
    setError('');
    try {
      setSettings(await api('/admin/settings', {
        method: 'PATCH',
        json: { erpFeaturesEnabled: !settings.erpFeaturesEnabled },
      }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Zoho expenses</h2>
      <p className="hint">An accountant can create one Zoho Books expense from an approved receipt. Invoices, bills, contacts, and bank transactions stay off.</p>
      {error && <p className="message message-bad">{error}</p>}
      {settings && (
        <>
          <p>{settings.erpFeaturesEnabled ? 'Expense export is on.' : 'Expense export is off.'}</p>
          <p>{settings.zohoConnected ? 'Zoho is connected.' : 'Zoho is not connected yet.'}</p>
          {settings.zohoMissing?.length > 0 && (
            <p className="hint">Still needed in .env: {settings.zohoMissing.join(', ')}</p>
          )}
          <div className="actions">
            <button type="button" className="btn btn-secondary" onClick={connect}>Connect Zoho</button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={toggle}>
              {settings.erpFeaturesEnabled ? 'Turn expense export off' : 'Turn expense export on'}
            </button>
          </div>
          {form && (
            <>
              <h3>Expense accounts</h3>
              <p className="hint">One row per Zoho account. A fuel receipt matches the car number to a petrol account, including a name like PETROL DK 8094 HF. Service, maintenance, and other bills match the supplier or description to the account name. The parent groups Petrol, Service Truck, and Repairs and Maintenance are not used.</p>
              {form.expense.map((row, index) => (
                <div key={index}>
                  <label className="field">
                    <span className="field-label">Receipt type {index + 1}</span>
                    <select value={row.documentType} onChange={(event) => setExpense(index, 'documentType', event.target.value)}>
                      {EXPENSE_ROWS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </label>
                  <label className="field">
                    <span className="field-label">Car number or name {index + 1}</span>
                    <input placeholder="DK 8618 HJ" value={row.key} onChange={(event) => setExpense(index, 'key', event.target.value)} />
                  </label>
                  <label className="field">
                    <span className="field-label">Zoho account name {index + 1}</span>
                    <input placeholder="PETROL DK 8094 HF" value={row.label} onChange={(event) => setExpense(index, 'label', event.target.value)} />
                  </label>
                  <label className="field">
                    <span className="field-label">Account id {index + 1}</span>
                    <input value={row.accountId} onChange={(event) => setExpense(index, 'accountId', event.target.value)} />
                  </label>
                </div>
              ))}
              <div className="actions">
                <button type="button" className="btn btn-secondary" onClick={() => setForm((current) => ({ ...current, expense: [...current.expense, { documentType: 'fuel_receipt', key: '', label: '', accountId: '' }] }))}>Add expense account</button>
              </div>
              <h3>Paid-through accounts</h3>
              <p className="hint">The payment method on the receipt picks this account. Use default when the method is blank or not listed. Cash and bank are different accounts.</p>
              {form.paid.map((row, index) => (
                <div key={index}>
                  <label className="field">
                    <span className="field-label">Payment method {index + 1}</span>
                    <input placeholder="Tunai, or default" value={row.key} onChange={(event) => setPaid(index, 'key', event.target.value)} />
                  </label>
                  <label className="field">
                    <span className="field-label">Paid-through name {index + 1}</span>
                    <input value={row.label} onChange={(event) => setPaid(index, 'label', event.target.value)} />
                  </label>
                  <label className="field">
                    <span className="field-label">Paid-through account id {index + 1}</span>
                    <input value={row.accountId} onChange={(event) => setPaid(index, 'accountId', event.target.value)} />
                  </label>
                </div>
              ))}
              <div className="actions">
                <button type="button" className="btn btn-secondary" onClick={() => setForm((current) => ({ ...current, paid: [...current.paid, { key: '', accountId: '', label: '' }] }))}>Add paid-through account</button>
                <button type="button" className="btn btn-primary" disabled={busy} onClick={saveAccounts}>Save Zoho accounts</button>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState('');
  const [health, setHealth] = useState('');

  useEffect(() => {
    fetchStats().then(setStats).catch((err) => setError(err.message));
    fetch('/health').then((response) => response.json()).then((body) => {
      setHealth(`${body.status} · database ${body.database}`);
    }).catch(() => setHealth('The server did not respond.'));
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
      <ZohoExpenses />
      <p className="hint">Sample files in the repository are fixtures. A document or screenshot appears here only after someone uploads it. {health}</p>
    </>
  );
}
