import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  fetchDeliveryDays,
  importDeliveryDay,
  importDeliveryHistory,
  deleteDeliveryDay,
  setCartrackEnabled,
} from '../../api/deliveries.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';

export default function DeliveryDays() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [days, setDays] = useState([]);
  const [cartrackEnabled, setCt] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [date, setDate] = useState('');
  const orderRef = useRef(null);
  const historyRef = useRef(null);

  function load() {
    fetchDeliveryDays()
      .then((body) => {
        setDays(body.days || []);
        setCt(Boolean(body.cartrackEnabled));
      })
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
      setMessage(`Imported ${result.summary?.stopCount || 0} stops for ${result.day?.date}.`);
      load();
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
      setMessage(`History: ${result.routeTabs} routes, ${result.customersTouched} customer rows, areas: ${(result.areas || []).join(', ')}`);
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

  async function toggleCartrack() {
    if (!isAdmin) return;
    setBusy(true);
    try {
      const body = await setCartrackEnabled(!cartrackEnabled);
      setCt(Boolean(body.cartrackEnabled));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Deliveries</h1>
          <p className="hint">Upload the daily list, fix locations, send maps to drivers, track status, check notas.</p>
        </div>
      </header>

      {error && <p className="message message-bad">{error}</p>}
      {message && <p className="message message-ok">{message}</p>}

      <section className="card">
        <h2>New day</h2>
        <p className="hint">Upload the order workbook (List editing Driver). Optional date override if the sheet name is unclear.</p>
        <div className="row gap">
          <label>
            Date (optional)
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => orderRef.current?.click()}>
            Upload order .xlsx
          </button>
          <input ref={orderRef} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={onImportOrder} />
        </div>
      </section>

      <section className="card">
        <h2>Learn from history</h2>
        <p className="hint">Upload past LIST DRIVER workbooks so areas, vehicles and customers are remembered.</p>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => historyRef.current?.click()}>
          Upload history .xlsx
        </button>
        <input ref={historyRef} type="file" accept=".xlsx" hidden onChange={onImportHistory} />
      </section>

      <section className="card">
        <h2>Cartrack</h2>
        <p className={cartrackEnabled ? 'message message-ok' : 'message message-warn'}>
          {cartrackEnabled ? 'Cartrack writes are on.' : 'Cartrack writes are off.'}
        </p>
        {isAdmin && (
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={toggleCartrack}>
            {cartrackEnabled ? 'Turn Cartrack off' : 'Turn Cartrack on'}
          </button>
        )}
      </section>

      <section className="card">
        <h2>Days</h2>
        {days.length === 0 && <p className="hint">No delivery days yet. Upload an order sheet.</p>}
        {days.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Status</th>
                  <th>Stops</th>
                  <th>Locations</th>
                  <th>New</th>
                  <th>Delivered</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {days.map((day) => (
                  <tr key={day._id}>
                    <td>
                      <Link to={`/deliveries/${day._id}`}>{day.date}</Link>
                      <div className="muted">{day.label}</div>
                    </td>
                    <td><StatusBadge status={day.status} /></td>
                    <td>{day.summary?.stopCount ?? '—'}</td>
                    <td>
                      {day.summary?.exactLocations ?? 0} exact
                      {day.summary?.needsLocation ? ` · ${day.summary.needsLocation} need pin` : ''}
                    </td>
                    <td>{day.summary?.newCustomers ?? 0}</td>
                    <td>{day.summary?.delivered ?? 0}</td>
                    <td>
                      <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => onDelete(day._id)}>
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
