import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  fetchDeliveryDays,
  importDeliveryDay,
  importDeliveryHistory,
  deleteDeliveryDay,
} from '../../api/deliveries.js';
import StatusBadge from '../../components/StatusBadge.jsx';

function todayIso() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export default function DeliveryDays() {
  const navigate = useNavigate();
  const [days, setDays] = useState([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [date, setDate] = useState(todayIso());
  const orderRef = useRef(null);
  const historyRef = useRef(null);

  function load() {
    fetchDeliveryDays()
      .then((body) => setDays(body.days || []))
      .catch((err) => setError(err.message));
  }

  useEffect(() => { load(); }, []);

  async function onImportOrder(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await importDeliveryDay(file, date || undefined);
      const id = result.day?._id || result.day?.id;
      setMessage(`Imported ${result.summary?.stopCount || 0} stops · split into areas with Maps links.`);
      load();
      if (id) navigate(`/deliver/${id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      event.target.value = '';
    }
  }

  async function onImportHistory(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await importDeliveryHistory(file);
      setMessage(`History saved · ${(result.areas || []).join(', ') || 'areas updated'}.`);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      event.target.value = '';
    }
  }

  async function onDelete(dayId) {
    if (!window.confirm('Delete this delivery day and all its stops?')) return;
    setBusy(true);
    try {
      await deleteDeliveryDay(dayId);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page sheet-page">
      <header className="page-header">
        <div>
          <h1>Deliver</h1>
          <p className="hint">Upload the Excel → auto Maps links → send to drivers by area.</p>
        </div>
      </header>

      {error && <p className="message message-bad">{error}</p>}
      {message && <p className="message message-ok">{message}</p>}

      <section className="card sheet-upload">
        <h2>Upload sheet</h2>
        <p className="hint">
          Pick the delivery date, then upload the order workbook. Stops are split by area automatically
          and each row gets a Google Maps link.
        </p>
        <div className="row gap wrap">
          <label className="field" style={{ margin: 0 }}>
            <span className="field-label">Date</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </label>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !date}
            onClick={() => orderRef.current?.click()}
          >
            {busy ? 'Uploading…' : 'Upload Excel'}
          </button>
          <input
            ref={orderRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            hidden
            onChange={onImportOrder}
          />
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => historyRef.current?.click()}>
            Learn history (optional)
          </button>
          <input ref={historyRef} type="file" accept=".xlsx" hidden onChange={onImportHistory} />
        </div>
      </section>

      <section className="card sheet-board">
        <h2>Days</h2>
        {days.length === 0 && <p className="hint">No days yet — upload a sheet above.</p>}
        {days.length > 0 && (
          <div className="table-wrap sheet-table">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Status</th>
                  <th>Stops</th>
                  <th>Maps ready</th>
                  <th>Need pin</th>
                  <th>Delivered</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {days.map((day) => (
                  <tr key={day._id}>
                    <td>
                      <Link to={`/deliver/${day._id}`}><strong>{day.date}</strong></Link>
                      {day.label && <div className="muted sheet-sub">{day.label}</div>}
                    </td>
                    <td><StatusBadge status={day.status} /></td>
                    <td>{day.summary?.stopCount ?? '—'}</td>
                    <td>{day.summary?.exactLocations ?? 0}</td>
                    <td>{day.summary?.needsLocation ?? 0}</td>
                    <td>{day.summary?.delivered ?? 0}</td>
                    <td className="sheet-actions">
                      <Link className="btn btn-primary btn-compact" to={`/deliver/${day._id}`}>Open</Link>
                      <button type="button" className="btn btn-secondary btn-compact" disabled={busy} onClick={() => onDelete(day._id)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
