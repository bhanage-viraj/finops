import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  fetchDeliveryDays,
  importDeliveryDay,
  importDeliverySheet,
  importDeliveryHistory,
  deleteDeliveryDay,
  downloadDayExport,
} from '../../api/deliveries.js';
import StatusBadge from '../../components/StatusBadge.jsx';

function displayDate(iso) {
  const [year, month, day] = String(iso || '').split('-');
  if (!year || !month || !day) return '';
  return `${day}/${month}/${year}`;
}

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
  const [sheetUrl, setSheetUrl] = useState('https://docs.google.com/spreadsheets/d/1llG2YXO0zXdKj5-T0bEr88gTtNg7-lRAagQ_b8sSQls/edit?usp=sharing');
  const orderRef = useRef(null);
  const historyRef = useRef(null);

  function load() {
    fetchDeliveryDays()
      .then((body) => setDays(body.days || []))
      .catch((err) => setError(err.message));
  }

  useEffect(() => { load(); }, []);

  async function onImportSheet() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await importDeliverySheet(sheetUrl, date);
      const id = result.day?._id || result.day?.id;
      const fleets = result.routes?.length || 0;
      const savedDate = displayDate(result.day?.date || date);
      const leftOut = result.skipped?.length
        ? ` ${result.skipped.length} lists were left out because the date printed on them was not ${savedDate}.`
        : '';
      setMessage(`Loaded ${result.summary?.stopCount || 0} deliveries in ${fleets} lists for ${savedDate}. Each tab stayed as it was split.${leftOut}`);
      load();
      if (id) navigate(`/deliver/${id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

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

  async function onDownload(dayId) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await downloadDayExport(dayId);
      setMessage('Excel downloaded. Each area is its own tab.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(dayId, dateLabel) {
    if (!window.confirm(`Delete sheet ${dateLabel || ''}? This removes all stops and areas for that day.`)) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await deleteDeliveryDay(dayId);
      setMessage('Sheet deleted.');
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
          <p className="hint">Use the Google Sheet. Each tab stays as she already split it. Send to driver sends that list.</p>
        </div>
      </header>

      {error && <p className="message message-bad">{error}</p>}
      {message && <p className="message message-ok">{message}</p>}

      <section className="card sheet-upload">
        <h2>Google Sheet</h2>
        <p className="hint">
          The date you pick is the delivery date. {displayDate(date) || 'That date'} loads the tabs named for that day,
          for example 21 OCT. Seminyak stays Seminyak. A list whose heading says a different date is left out.
        </p>
        <div className="row gap wrap">
          <label className="field" style={{ margin: 0 }}>
            <span className="field-label">Date</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </label>
          <label className="field" style={{ margin: 0, minWidth: 280, flex: '1 1 320px' }}>
            <span className="field-label">Google Sheet</span>
            <input
              value={sheetUrl}
              onChange={(event) => setSheetUrl(event.target.value)}
              placeholder="Public Google Sheets link"
            />
          </label>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !date || !sheetUrl.trim()}
            onClick={onImportSheet}
          >
            {busy ? 'Loading…' : 'Use this sheet'}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy || !date}
            onClick={() => orderRef.current?.click()}
          >
            Upload Excel
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
                      <button
                        type="button"
                        className="btn btn-secondary btn-compact"
                        disabled={busy}
                        onClick={() => onDownload(day._id)}
                      >
                        Download Excel
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-compact"
                        disabled={busy}
                        onClick={() => onDelete(day._id, day.date)}
                      >
                        Delete sheet
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
