import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  fetchDeliveryDay,
  fetchDeliveryMeta,
  fetchNeedsLocation,
  fetchDayReport,
  fetchAtRisk,
  fetchRouteMessage,
  fetchGpsSuggestions,
  setStopLocation,
  setStopStatus,
  moveStop,
  updateRoute,
  markMapSent,
  reorderRoute,
  dispatchDay,
  closeDay,
  downloadDayExport,
  syncCartrack,
  uploadNota,
  confirmNota,
  fetchEmpties,
} from '../../api/deliveries.js';
import StatusBadge from '../../components/StatusBadge.jsx';
import LocationMap from './LocationMap.jsx';

const TABS = [
  ['overview', 'Overview'],
  ['locations', 'Needs location'],
  ['routes', 'Routes'],
  ['today', 'Today'],
  ['nota', 'Nota check'],
  ['report', 'Report'],
];

function mapsUrl(stop) {
  const loc = stop.location || {};
  if (loc.mapsUrl) return loc.mapsUrl;
  if (loc.lat != null && loc.lng != null) {
    return `https://www.google.com/maps/search/?api=1&query=${loc.lat},${loc.lng}`;
  }
  const q = encodeURIComponent([loc.placeName, loc.address, 'Bali'].filter(Boolean).join(', '));
  return q ? `https://www.google.com/maps/search/?api=1&query=${q}` : '';
}

export default function DayDetail() {
  const { dayId } = useParams();
  const [tab, setTab] = useState('overview');
  const [day, setDay] = useState(null);
  const [routes, setRoutes] = useState([]);
  const [stops, setStops] = useState([]);
  const [meta, setMeta] = useState({ areas: [], vehicles: [], drivers: [] });
  const [needs, setNeeds] = useState([]);
  const [report, setReport] = useState(null);
  const [atRisk, setAtRisk] = useState(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [selectedRouteId, setSelectedRouteId] = useState('');
  const [msgPreview, setMsgPreview] = useState(null);
  const [gps, setGps] = useState([]);
  const [empties, setEmpties] = useState(null);
  const [pinStop, setPinStop] = useState(null);
  const [linkDraft, setLinkDraft] = useState('');

  const load = useCallback(async () => {
    const body = await fetchDeliveryDay(dayId);
    setDay(body.day);
    setRoutes(body.routes || []);
    setStops(body.stops || []);
    if (!selectedRouteId && body.routes?.[0]) setSelectedRouteId(body.routes[0]._id);
  }, [dayId, selectedRouteId]);

  useEffect(() => {
    setError('');
    load().catch((err) => setError(err.message));
    fetchDeliveryMeta().then(setMeta).catch(() => {});
  }, [dayId]);

  useEffect(() => {
    if (tab === 'locations') {
      fetchNeedsLocation(dayId).then((b) => setNeeds(b.stops || [])).catch((e) => setError(e.message));
    }
    if (tab === 'report') {
      fetchDayReport(dayId).then(setReport).catch((e) => setError(e.message));
      fetchAtRisk(dayId).then(setAtRisk).catch(() => {});
    }
    if (tab === 'today') {
      fetchGpsSuggestions(dayId).then((b) => setGps(b.suggestions || [])).catch(() => setGps([]));
      const timer = setInterval(() => {
        load().catch(() => {});
        fetchGpsSuggestions(dayId).then((b) => setGps(b.suggestions || [])).catch(() => {});
      }, 120000);
      return () => clearInterval(timer);
    }
    return undefined;
  }, [tab, dayId, load]);

  const selectedRoute = useMemo(
    () => routes.find((r) => r._id === selectedRouteId),
    [routes, selectedRouteId],
  );
  const routeStops = useMemo(
    () => stops.filter((s) => String(s.routeId) === String(selectedRouteId)).sort((a, b) => a.sortIndex - b.sortIndex),
    [stops, selectedRouteId],
  );

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
      const body = await fetchNeedsLocation(dayId);
      setNeeds(body.stops || []);
      setPinStop(null);
      setLinkDraft('');
    }, 'Location saved on the customer.');
  }

  async function showMessage(routeId) {
    setBusy(true);
    setError('');
    try {
      setMsgPreview(await fetchRouteMessage(routeId));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function loadEmpties(routeId) {
    try {
      setEmpties(await fetchEmpties(routeId));
    } catch {
      setEmpties(null);
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

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="hint"><Link to="/deliver">Deliver</Link></p>
          <h1>{day.date}</h1>
          <p className="hint">{day.label} · <StatusBadge status={day.status} /></p>
        </div>
        <div className="row gap">
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => run(() => dispatchDay(dayId), 'Marked dispatched.')}>
            Dispatch
          </button>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => run(() => downloadDayExport(dayId), 'Download started.')}>
            Download .xlsx
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => run(() => closeDay(dayId), 'Day closed.')}>
            Close day
          </button>
        </div>
      </header>

      {error && <p className="message message-bad">{error}</p>}
      {message && <p className="message message-ok">{message}</p>}

      <div className="chips" role="tablist">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={tab === id ? 'chip chip-active' : 'chip'}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <section className="card">
          <h2>Summary</h2>
          <div className="stat-grid">
            <div><div className="stat-num">{day.summary?.stopCount ?? stops.length}</div><div className="muted">Stops</div></div>
            <div><div className="stat-num">{day.summary?.exactLocations ?? 0}</div><div className="muted">Exact locations</div></div>
            <div><div className="stat-num">{day.summary?.needsLocation ?? 0}</div><div className="muted">Need pin</div></div>
            <div><div className="stat-num">{day.summary?.newCustomers ?? 0}</div><div className="muted">New customers</div></div>
            <div><div className="stat-num">{day.summary?.unassigned ?? 0}</div><div className="muted">Unassigned</div></div>
            <div><div className="stat-num">{day.summary?.delivered ?? 0}</div><div className="muted">Delivered</div></div>
          </div>
          <h3>Routes</h3>
          <ul className="plain-list">
            {routes.map((r) => (
              <li key={r._id}>
                <button type="button" className="linkish" onClick={() => { setSelectedRouteId(r._id); setTab('routes'); }}>
                  {r.number ? `${r.number}. ` : ''}{r.areaName}
                </button>
                {' — '}
                {stops.filter((s) => String(s.routeId) === String(r._id)).length} stops
                {r.vehicleLabel ? ` · ${r.vehicleLabel}` : ''}
                {r.driverNames?.length ? ` · ${r.driverNames.join(' & ')}` : ''}
              </li>
            ))}
          </ul>
        </section>
      )}

      {tab === 'locations' && (
        <section className="card">
          <h2>Needs location ({needs.length})</h2>
          <p className="hint">Paste a Google Maps link or drop a pin. Saved on the customer for next time.</p>
          {needs.length === 0 && <p className="message message-ok">All stops have a usable location.</p>}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Address</th>
                  <th>Fix</th>
                </tr>
              </thead>
              <tbody>
                {needs.map((stop) => (
                  <tr key={stop._id}>
                    <td>
                      {stop.customerName}
                      {stop.isNewCustomer && <span className="badge badge-warn"> NEW</span>}
                    </td>
                    <td>
                      <div>{stop.location?.placeName}</div>
                      <div className="muted">{stop.location?.address}</div>
                    </td>
                    <td>
                      <div className="row gap">
                        <input
                          placeholder="Paste maps link or GPS"
                          value={pinStop === stop._id ? linkDraft : ''}
                          onChange={(e) => { setPinStop(stop._id); setLinkDraft(e.target.value); }}
                          onFocus={() => setPinStop(stop._id)}
                        />
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={busy || pinStop !== stop._id || !linkDraft}
                          onClick={() => saveLocation(stop._id, /https?:\/\//.test(linkDraft)
                            ? { mapsUrl: linkDraft }
                            : { text: linkDraft })}
                        >
                          Save
                        </button>
                        <button type="button" className="btn btn-secondary" onClick={() => setPinStop(stop._id)}>
                          Pin
                        </button>
                      </div>
                      {pinStop === stop._id && (
                        <LocationMap
                          address={stop.location?.address}
                          initial={stop.location?.lat != null ? { lat: stop.location.lat, lng: stop.location.lng } : null}
                          onPick={(coords) => saveLocation(stop._id, coords)}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === 'routes' && (
        <>
          <section className="card">
            <h2>Route planner</h2>
            <div className="row gap wrap">
              {routes.map((r) => (
                <button
                  key={r._id}
                  type="button"
                  className={selectedRouteId === r._id ? 'chip chip-active' : 'chip'}
                  onClick={() => { setSelectedRouteId(r._id); setMsgPreview(null); loadEmpties(r._id); }}
                >
                  {r.areaName} ({stops.filter((s) => String(s.routeId) === String(r._id)).length})
                </button>
              ))}
            </div>
          </section>

          {selectedRoute && (
            <section className="card">
              <h2>{selectedRoute.areaName}</h2>
              <div className="row gap wrap">
                <label>
                  Vehicle
                  <select
                    value={selectedRoute.vehicleId || ''}
                    onChange={(e) => run(() => updateRoute(selectedRoute._id, { vehicleId: e.target.value || null }))}
                  >
                    <option value="">—</option>
                    {meta.vehicles.map((v) => (
                      <option key={v._id} value={v._id}>{v.type} {v.plate}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Drivers
                  <select
                    multiple
                    value={selectedRoute.driverIds || []}
                    onChange={(e) => {
                      const ids = [...e.target.selectedOptions].map((o) => o.value);
                      run(() => updateRoute(selectedRoute._id, { driverIds: ids }));
                    }}
                  >
                    {meta.drivers.map((d) => (
                      <option key={d._id} value={d._id}>{d.name}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="row gap wrap" style={{ marginTop: 12 }}>
                <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => run(() => reorderRoute(selectedRoute._id), 'Reordered.')}>
                  Reorder nearest
                </button>
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => showMessage(selectedRoute._id)}>
                  WhatsApp message
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => run(async () => {
                    await markMapSent(selectedRoute._id);
                    const msg = await fetchRouteMessage(selectedRoute._id);
                    setMsgPreview(msg);
                  }, 'Marked map sent.')}
                >
                  Mark map sent
                </button>
              </div>

              {msgPreview && (
                <div className="card" style={{ marginTop: 16 }}>
                  <h3>Message preview</h3>
                  {msgPreview.needsCheck > 0 && (
                    <p className="message message-warn">{msgPreview.needsCheck} stops need a location check before sending.</p>
                  )}
                  <textarea readOnly rows={14} value={msgPreview.text} style={{ width: '100%' }} />
                  <div className="row gap">
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => navigator.clipboard.writeText(msgPreview.text)}
                    >
                      Copy
                    </button>
                    <a className="btn btn-secondary" href={msgPreview.whatsappUrl} target="_blank" rel="noreferrer">
                      Open WhatsApp Web
                    </a>
                  </div>
                </div>
              )}

              <div className="table-wrap" style={{ marginTop: 16 }}>
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Customer</th>
                      <th>Items</th>
                      <th>Note</th>
                      <th>Maps</th>
                      <th>Move</th>
                    </tr>
                  </thead>
                  <tbody>
                    {routeStops.map((stop, idx) => (
                      <tr key={stop._id}>
                        <td>{idx + 1}</td>
                        <td>
                          {stop.customerName}
                          {stop.isNewCustomer && <span className="badge badge-warn"> NEW</span>}
                          {stop.location?.needsPin && <span className="badge badge-warn"> CEK</span>}
                        </td>
                        <td>
                          {(stop.plannedItems || []).map((item, i) => (
                            <div key={i}>{item.productName} {item.qty != null ? `×${item.qty}` : ''}</div>
                          ))}
                        </td>
                        <td className="muted">{(stop.note || '').slice(0, 80)}</td>
                        <td>
                          {mapsUrl(stop) && (
                            <a href={mapsUrl(stop)} target="_blank" rel="noreferrer">Open</a>
                          )}
                        </td>
                        <td>
                          <select
                            value={stop.routeId || ''}
                            onChange={(e) => run(() => moveStop(stop._id, { routeId: e.target.value }), 'Moved.')}
                          >
                            {routes.map((r) => (
                              <option key={r._id} value={r._id}>{r.areaName}</option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {selectedRoute.loadingTotals && (
                <div style={{ marginTop: 12 }}>
                  <h3>Loading list</h3>
                  <ul className="plain-list">
                    {Object.entries(selectedRoute.loadingTotals).map(([name, row]) => (
                      <li key={name}>{name}: {row.qty}{row.qtyMissing ? ' (+missing qty)' : ''}</li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}
        </>
      )}

      {tab === 'today' && (
        <section className="card">
          <h2>Today board</h2>
          <div className="row gap">
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => run(() => syncCartrack(dayId), 'Synced from Cartrack.')}>
              Sync Cartrack
            </button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => load()}>
              Refresh
            </button>
          </div>
          {gps.length > 0 && (
            <div className="message message-warn" style={{ marginTop: 12 }}>
              GPS suggestions (not delivered): {gps.map((g) => `${g.customerName} (~${g.distanceM}m)`).join('; ')}
            </div>
          )}
          {routes.map((route) => {
            const rs = stops.filter((s) => String(s.routeId) === String(route._id)).sort((a, b) => a.sortIndex - b.sortIndex);
            return (
              <div key={route._id} style={{ marginTop: 20 }}>
                <h3>{route.areaName} · {route.vehicleLabel || 'no vehicle'} · {(route.driverNames || []).join(' & ')}</h3>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Customer</th>
                        <th>Status</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rs.map((stop) => (
                        <tr key={stop._id}>
                          <td>
                            {stop.customerName}
                            {stop.isPriority && <span className="badge badge-warn"> PRIORITY</span>}
                          </td>
                          <td><StatusBadge status={stop.status} /></td>
                          <td className="row gap wrap">
                            {['otw', 'arrived', 'delivered', 'failed'].map((st) => (
                              <button
                                key={st}
                                type="button"
                                className="btn btn-secondary"
                                disabled={busy || stop.status === st}
                                onClick={() => run(() => setStopStatus(stop._id, { status: st, source: 'admin' }))}
                              >
                                {st}
                              </button>
                            ))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </section>
      )}

      {tab === 'nota' && (
        <section className="card">
          <h2>Nota check</h2>
          <p className="hint">Photograph the Nota Penjualan. AI drafts fields; you confirm. Mismatches are listed.</p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Planned</th>
                  <th>Status</th>
                  <th>Flags</th>
                  <th>Nota</th>
                </tr>
              </thead>
              <tbody>
                {stops.map((stop) => (
                  <tr key={stop._id}>
                    <td>{stop.customerName}</td>
                    <td>
                      {(stop.plannedItems || []).map((item, i) => (
                        <div key={i}>{item.productName} ×{item.qty ?? '?'}</div>
                      ))}
                    </td>
                    <td><StatusBadge status={stop.status} /></td>
                    <td>
                      {(stop.mismatchFlags || []).map((f) => (
                        <span key={f} className="badge badge-warn">{f}</span>
                      ))}
                    </td>
                    <td>
                      <input
                        type="file"
                        accept="image/*"
                        disabled={busy}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          run(async () => {
                            await uploadNota(stop._id, file, false);
                          }, 'Nota read. Review flags, then confirm.');
                          e.target.value = '';
                        }}
                      />
                      {stop.ai && !stop.ai.failed && (
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={busy}
                          onClick={() => run(() => confirmNota(stop._id, {}), 'Nota confirmed.')}
                        >
                          Confirm
                        </button>
                      )}
                      {stop.ai?.notaNo && <div className="muted">No: {stop.ai.notaNo}</div>}
                      {stop.ai?.total != null && <div className="muted">Total: {stop.ai.total}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {selectedRouteId && (
            <button type="button" className="btn btn-secondary" onClick={() => loadEmpties(selectedRouteId)}>
              Empties balance (selected route)
            </button>
          )}
          {empties && (
            <p className="hint">
              Planned gallons {empties.plannedGallons}, empties returned {empties.emptiesReturned}, difference {empties.difference}.
            </p>
          )}
        </section>
      )}

      {tab === 'report' && report && (
        <section className="card">
          <h2>Day report</h2>
          {atRisk?.atRisk && (
            <p className="message message-bad">
              At risk for 17:00 — {atRisk.stops.length} stops still open.
            </p>
          )}
          <h3>By status</h3>
          <ul className="plain-list">
            {Object.entries(report.byStatus || {}).map(([k, v]) => (
              <li key={k}>{k}: {v}</li>
            ))}
          </ul>
          <h3>Handover</h3>
          <p>{report.handover?.notes || 'Nothing pending.'}</p>
          <h3>New customers</h3>
          <ul className="plain-list">
            {(report.newCustomers || []).map((s) => (
              <li key={s._id}>{s.customerName}</li>
            ))}
          </ul>
          <h3>Mismatches</h3>
          <ul className="plain-list">
            {(report.mismatches || []).map((s) => (
              <li key={s._id}>{s.customerName}: {(s.mismatchFlags || []).join(', ')}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
