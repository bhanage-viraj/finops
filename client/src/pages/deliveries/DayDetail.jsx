import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  fetchDeliveryDay,
  fetchRouteMessage,
  markMapSent,
  moveStop,
  setStopLocation,
  setStopStatus,
  syncCartrack,
  uploadNota,
  confirmNota,
  deleteDeliveryDay,
} from '../../api/deliveries.js';
import StatusBadge from '../../components/StatusBadge.jsx';
import LocationMap from './LocationMap.jsx';

function mapsUrl(stop) {
  const loc = stop.location || {};
  if (loc.mapsUrl) return loc.mapsUrl;
  if (loc.lat != null && loc.lng != null) {
    return `https://www.google.com/maps/search/?api=1&query=${loc.lat},${loc.lng}`;
  }
  const q = encodeURIComponent([loc.placeName, loc.address, 'Bali'].filter(Boolean).join(', '));
  return q ? `https://www.google.com/maps/search/?api=1&query=${q}` : '';
}

function stopWhatsAppUrl(stop) {
  const url = mapsUrl(stop);
  if (!url) return '';
  const text = `*${stop.customerName}*\n${url}`;
  return `https://web.whatsapp.com/send?text=${encodeURIComponent(text)}`;
}

function itemsLabel(stop) {
  return (stop.plannedItems || [])
    .map((item) => `${item.productName}${item.qty != null ? ` ×${item.qty}` : ''}`)
    .join(', ');
}

export default function DayDetail() {
  const { dayId } = useParams();
  const navigate = useNavigate();
  const [view, setView] = useState('areas'); // areas | all
  const [day, setDay] = useState(null);
  const [routes, setRoutes] = useState([]);
  const [stops, setStops] = useState([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [pinStop, setPinStop] = useState(null);
  const [linkDraft, setLinkDraft] = useState('');
  const [sendQueue, setSendQueue] = useState([]); // route ids left to send
  const [preview, setPreview] = useState(null);
  const notaRefs = useRef({});

  const load = useCallback(async () => {
    const body = await fetchDeliveryDay(dayId);
    setDay(body.day);
    setRoutes(body.routes || []);
    setStops(body.stops || []);
  }, [dayId]);

  useEffect(() => {
    setError('');
    load().catch((err) => setError(err.message));
    // Pull Cartrack statuses in the background (read-only).
    syncCartrack(dayId).then(() => load()).catch(() => {});
  }, [dayId, load]);

  const stopsByRoute = useMemo(() => {
    const map = new Map();
    for (const route of routes) map.set(String(route._id), []);
    map.set('none', []);
    for (const stop of stops) {
      const key = stop.routeId ? String(stop.routeId) : 'none';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(stop);
    }
    for (const list of map.values()) list.sort((a, b) => a.sortIndex - b.sortIndex);
    return map;
  }, [routes, stops]);

  const areaSections = useMemo(() => {
    const sections = routes.map((route) => ({
      key: String(route._id),
      route,
      title: route.areaName || 'Area',
      subtitle: [route.vehicleLabel, (route.driverNames || []).join(' & ')].filter(Boolean).join(' · '),
      stops: stopsByRoute.get(String(route._id)) || [],
    }));
    const loose = stopsByRoute.get('none') || [];
    if (loose.length) {
      sections.push({
        key: 'none',
        route: null,
        title: 'Unassigned',
        subtitle: 'Not matched to an area yet — move into an area below',
        stops: loose,
      });
    }
    return sections;
  }, [routes, stopsByRoute]);

  async function run(fn, okMessage) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await fn();
      if (okMessage) setMessage(okMessage);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveLocation(stopId, payload) {
    await run(async () => {
      await setStopLocation(stopId, payload);
      setPinStop(null);
      setLinkDraft('');
    }, 'Location saved.');
  }

  async function openAreaSend(routeId) {
    setBusy(true);
    setError('');
    try {
      const msg = await fetchRouteMessage(routeId);
      setPreview({ routeId, ...msg });
      await markMapSent(routeId);
      window.open(msg.whatsappUrl, '_blank', 'noopener,noreferrer');
      setMessage('WhatsApp Web opened for this area. Attach nothing — maps are in the message.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function startSendAllAreas() {
    const ids = routes.map((r) => String(r._id));
    if (!ids.length) {
      setError('No areas to send.');
      return;
    }
    setSendQueue(ids.slice(1));
    await openAreaSend(ids[0]);
    if (ids.length > 1) {
      setMessage(`Sent area 1 of ${ids.length}. Click “Send next area” for the rest.`);
    }
  }

  async function sendNextArea() {
    if (!sendQueue.length) return;
    const [next, ...rest] = sendQueue;
    setSendQueue(rest);
    await openAreaSend(next);
    if (rest.length) {
      setMessage(`Sent. ${rest.length} area${rest.length === 1 ? '' : 's'} left — click “Send next area”.`);
    } else {
      setMessage('All areas opened in WhatsApp Web.');
    }
  }

  async function onNota(stopId, file) {
    if (!file) return;
    await run(async () => {
      const result = await uploadNota(stopId, file, false);
      if (result?.nota?._id || result?.stop) {
        // Auto-confirm when AI read succeeded with no hard block.
        try {
          await confirmNota(stopId, {});
        } catch {
          // Keep draft if confirm needs a person.
        }
      }
    }, 'Nota uploaded — quantities updated when the check passed.');
  }

  async function onDeleteSheet() {
    if (!window.confirm(`Delete sheet ${day?.date || ''}? This removes all stops and areas for that day.`)) return;
    setBusy(true);
    setError('');
    try {
      await deleteDeliveryDay(dayId);
      navigate('/deliver');
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  if (!day) {
    return (
      <div className="page">
        <p className="hint">Loading…</p>
        {error && <p className="message message-bad">{error}</p>}
      </div>
    );
  }

  function renderStopRows(list, showAreaMove) {
    return list.map((stop, idx) => {
      const url = mapsUrl(stop);
      const wa = stopWhatsAppUrl(stop);
      return (
        <tr key={stop._id} className={stop.location?.needsPin ? 'sheet-row-warn' : undefined}>
          <td className="sheet-num">{idx + 1}</td>
          <td>
            <strong>{stop.customerName}</strong>
            {stop.isNewCustomer && <span className="badge badge-warn"> NEW</span>}
            {stop.location?.needsPin && <span className="badge badge-warn"> CEK LOKASI</span>}
            <div className="muted sheet-sub">{stop.location?.address || stop.location?.placeName || '—'}</div>
          </td>
          <td className="sheet-items">{itemsLabel(stop) || '—'}</td>
          <td><StatusBadge status={stop.status} /></td>
          <td className="sheet-actions">
            {url ? (
              <a className="btn btn-secondary btn-compact" href={url} target="_blank" rel="noreferrer">Map</a>
            ) : (
              <span className="muted">No map</span>
            )}
            {wa && (
              <a className="btn btn-primary btn-compact" href={wa} target="_blank" rel="noreferrer">Send</a>
            )}
          </td>
          <td className="sheet-actions">
            <button
              type="button"
              className="btn btn-secondary btn-compact"
              disabled={busy}
              onClick={() => notaRefs.current[stop._id]?.click()}
            >
              Nota
            </button>
            <input
              ref={(el) => { notaRefs.current[stop._id] = el; }}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) onNota(stop._id, file);
              }}
            />
            {showAreaMove && (
              <select
                className="sheet-move"
                value={stop.routeId || ''}
                disabled={busy}
                onChange={(e) => run(() => moveStop(stop._id, { routeId: e.target.value || null }), 'Moved.')}
              >
                <option value="">Unassigned</option>
                {routes.map((r) => (
                  <option key={r._id} value={r._id}>{r.areaName}</option>
                ))}
              </select>
            )}
          </td>
          <td>
            {stop.location?.needsPin && (
              <div className="sheet-fix">
                <input
                  placeholder="Paste Maps link"
                  value={pinStop === stop._id ? linkDraft : ''}
                  onChange={(e) => { setPinStop(stop._id); setLinkDraft(e.target.value); }}
                  onFocus={() => setPinStop(stop._id)}
                />
                <button
                  type="button"
                  className="btn btn-primary btn-compact"
                  disabled={busy || pinStop !== stop._id || !linkDraft}
                  onClick={() => saveLocation(stop._id, { mapsUrl: linkDraft })}
                >
                  Save
                </button>
                {pinStop === stop._id && (
                  <LocationMap
                    address={stop.location?.address}
                    initial={stop.location?.lat != null ? { lat: stop.location.lat, lng: stop.location.lng } : null}
                    onPick={(coords) => saveLocation(stop._id, coords)}
                  />
                )}
              </div>
            )}
            {!stop.location?.needsPin && (
              <button
                type="button"
                className="linkish"
                disabled={busy}
                onClick={() => run(
                  () => setStopStatus(stop._id, { status: stop.status === 'delivered' ? 'otw' : 'delivered', source: 'admin' }),
                  'Status updated.',
                )}
              >
                {stop.status === 'delivered' || stop.status === 'nota_checked' ? 'Undo delivered' : 'Mark delivered'}
              </button>
            )}
          </td>
        </tr>
      );
    });
  }

  const tableHead = (
    <thead>
      <tr>
        <th>#</th>
        <th>Customer / address</th>
        <th>Items</th>
        <th>Status</th>
        <th>Maps</th>
        <th>Nota / area</th>
        <th>Fix</th>
      </tr>
    </thead>
  );

  return (
    <div className="page sheet-page">
      <header className="page-header">
        <div>
          <p className="hint"><Link to="/deliver">← Deliver</Link></p>
          <h1>{day.date}</h1>
          <p className="hint">
            {day.summary?.stopCount ?? stops.length} stops · {routes.length} areas ·{' '}
            <StatusBadge status={day.status} />
          </p>
        </div>
        <div className="row gap wrap">
          <div className="chips" role="tablist">
            <button type="button" className={view === 'areas' ? 'chip chip-active' : 'chip'} onClick={() => setView('areas')}>
              By area
            </button>
            <button type="button" className={view === 'all' ? 'chip chip-active' : 'chip'} onClick={() => setView('all')}>
              Whole sheet
            </button>
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => run(async () => { await syncCartrack(dayId); }, 'Statuses refreshed from Cartrack.')}
          >
            Sync Cartrack
          </button>
          {view === 'areas' && (
            <button type="button" className="btn btn-primary" disabled={busy || !routes.length} onClick={startSendAllAreas}>
              Send all areas
            </button>
          )}
          {sendQueue.length > 0 && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={sendNextArea}>
              Send next area ({sendQueue.length} left)
            </button>
          )}
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={onDeleteSheet}>
            Delete sheet
          </button>
        </div>
      </header>

      {error && <p className="message message-bad">{error}</p>}
      {message && <p className="message message-ok">{message}</p>}

      {preview && (
        <section className="card sheet-preview">
          <div className="row gap wrap" style={{ justifyContent: 'space-between' }}>
            <p className="hint" style={{ margin: 0 }}>Last message ({preview.stopCount} stops){preview.needsCheck ? ` · ${preview.needsCheck} need location check` : ''}</p>
            <button type="button" className="btn btn-secondary btn-compact" onClick={() => navigator.clipboard.writeText(preview.text)}>
              Copy text
            </button>
          </div>
        </section>
      )}

      {view === 'all' && (
        <section className="card sheet-board">
          <div className="sheet-area-head">
            <h2>Whole sheet</h2>
            <p className="hint">All stops in one list. Move rows into areas, or switch to “By area” to send.</p>
          </div>
          <div className="table-wrap sheet-table">
            <table>
              {tableHead}
              <tbody>{renderStopRows(stops.slice().sort((a, b) => a.sortIndex - b.sortIndex), true)}</tbody>
            </table>
          </div>
        </section>
      )}

      {view === 'areas' && areaSections.map((section) => (
        <section key={section.key} className="card sheet-board">
          <div className="sheet-area-head">
            <div>
              <h2>{section.title}</h2>
              <p className="hint">
                {section.stops.length} stops
                {section.subtitle ? ` · ${section.subtitle}` : ''}
                {section.route?.mapSentAt ? ' · maps sent' : ''}
              </p>
            </div>
            {section.route && (
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || section.stops.length === 0}
                onClick={() => openAreaSend(section.route._id)}
              >
                Send area to driver
              </button>
            )}
          </div>
          <div className="table-wrap sheet-table">
            <table>
              {tableHead}
              <tbody>{renderStopRows(section.stops, true)}</tbody>
            </table>
          </div>
        </section>
      ))}

      {view === 'areas' && areaSections.length === 0 && (
        <p className="hint">No stops yet for this day.</p>
      )}
    </div>
  );
}
