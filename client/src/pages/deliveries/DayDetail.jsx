import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  fetchDeliveryDay,
  fetchDeliveryMeta,
  fetchRouteMessage,
  markMapSent,
  moveStops,
  setStopLocation,
  setStopStatus,
  syncCartrack,
  uploadNota,
  confirmNota,
  deleteDeliveryDay,
  clearRouteMaps,
  deleteStops,
  deleteFleet,
  updateRoute,
} from '../../api/deliveries.js';
import StatusBadge from '../../components/StatusBadge.jsx';
import { formatRupiah } from '../../utils/formatRupiah.js';
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

function cargoLabel(totals) {
  const parts = Object.entries(totals || {})
    .map(([name, row]) => {
      const qty = Number(row?.qty);
      return qty > 0 ? `${name} ${qty}` : '';
    })
    .filter(Boolean);
  return parts.join(' · ');
}

function fleetLabel(route, stopCount) {
  if (!route) return 'Unassigned';
  const drivers = (route.driverNames || []).filter(Boolean).join(' & ');
  const bits = [route.areaName || 'Fleet'];
  if (route.vehicleLabel) bits.push(route.vehicleLabel);
  if (drivers) bits.push(drivers);
  if (stopCount != null) bits.push(`${stopCount} stops`);
  return bits.join(' · ');
}

function itemsLabel(stop) {
  return (stop.plannedItems || [])
    .map((item) => {
      const qty = item.qty != null ? ` ×${item.qty}` : '';
      const price = Number.isInteger(item.unitPrice) ? ` ${formatRupiah(item.unitPrice)}` : '';
      return `${item.productName}${qty}${price}`;
    })
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
  const [picked, setPicked] = useState(() => new Set());
  const [moveTarget, setMoveTarget] = useState('');
  const [meta, setMeta] = useState({ vehicles: [], drivers: [] });
  const [customId, setCustomId] = useState('');
  const [fleetName, setFleetName] = useState('');
  const [vehicleId, setVehicleId] = useState('');
  const [driverId, setDriverId] = useState('');
  const [menuKey, setMenuKey] = useState(0);
  const notaRefs = useRef({});

  const load = useCallback(async () => {
    const body = await fetchDeliveryDay(dayId);
    setDay(body.day);
    setRoutes(body.routes || []);
    setStops(body.stops || []);
  }, [dayId]);

  useEffect(() => {
    setError('');
    setPicked(new Set());
    setMoveTarget('');
    load().catch((err) => setError(err.message));
    fetchDeliveryMeta().then((body) => {
      setMeta({ vehicles: body.vehicles || [], drivers: body.drivers || [] });
    }).catch(() => {});
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

  function openCustomise(route) {
    setCustomId(String(route._id));
    setFleetName(route.areaName || '');
    setVehicleId(route.vehicleId ? String(route.vehicleId) : '');
    setDriverId(route.driverIds?.[0] ? String(route.driverIds[0]) : '');
  }

  async function saveCustomise(routeId) {
    await updateRoute(routeId, {
      areaName: fleetName,
      vehicleId: vehicleId || null,
      driverIds: driverId ? [driverId] : [],
    });
    setCustomId('');
    setMessage('Fleet updated.');
  }

  async function onFleetDelete(section, choice) {
    if (choice === 'maps') {
      if (!window.confirm(`Delete the maps for ${section.title}? Customer pins stay.`)) return;
      await run(() => clearRouteMaps(section.route._id), 'Maps deleted. Send this fleet again when the load is right.');
      return;
    }
    if (choice === 'fleet') {
      if (!window.confirm(`Remove ${section.title}? Its stops stay on the day, with no fleet.`)) return;
      await run(() => deleteFleet(section.route._id, { alsoStops: false }), 'Fleet removed. The stops are unassigned.');
      return;
    }
    if (choice === 'stops') {
      if (!window.confirm(`Delete ${section.title} and its stops? Delivered stops cannot be deleted.`)) return;
      await run(() => deleteFleet(section.route._id, { alsoStops: true }), 'Fleet and its stops deleted.');
    }
  }

  async function moveChosen(stopIds, routeId) {
    const result = await moveStops(dayId, { stopIds, routeId });
    setPicked(new Set());
    setMoveTarget('');
    setMessage(result.mapsStale
      ? 'Moved. Delete the maps on the fleets that already had one, then send them again.'
      : `Moved ${result.moved} stop${result.moved === 1 ? '' : 's'}.`);
  }

  function togglePicked(stopId) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(stopId)) next.delete(stopId);
      else next.add(stopId);
      return next;
    });
  }

  function selectFleet(list, on) {
    setPicked((prev) => {
      const next = new Set(prev);
      for (const stop of list) {
        if (on) next.add(stop._id);
        else next.delete(stop._id);
      }
      return next;
    });
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
          <td className="sheet-pick">
            <input
              type="checkbox"
              checked={picked.has(stop._id)}
              aria-label={`Select ${stop.customerName}`}
              onChange={() => togglePicked(stop._id)}
            />
          </td>
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
                value={stop.routeId || 'unassigned'}
                disabled={busy}
                aria-label={`Move ${stop.customerName} to another fleet`}
                onChange={(e) => {
                  const value = e.target.value;
                  if (value === (stop.routeId || 'unassigned')) return;
                  run(() => moveChosen([stop._id], value));
                }}
              >
                <option value="new">New fleet</option>
                <option value="unassigned">Unassigned</option>
                {routes.map((route) => (
                  <option key={route._id} value={route._id}>
                    {fleetLabel(route, (stopsByRoute.get(String(route._id)) || []).length)}
                  </option>
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
        <th />
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
            {day.summary?.stopCount ?? stops.length} stops · {routes.length} fleets ·{' '}
            <StatusBadge status={day.status} />
          </p>
          <p className="hint">
            Each area starts as one fleet. Tick the stops that do not fit, then move them to another fleet or a new fleet.
            If a map was already sent, delete it and send that fleet again.
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
              Send all fleets
            </button>
          )}
          {sendQueue.length > 0 && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={sendNextArea}>
              Send next fleet ({sendQueue.length} left)
            </button>
          )}
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={onDeleteSheet}>
            Delete sheet
          </button>
        </div>
      </header>

      {error && <p className="message message-bad">{error}</p>}
      {message && <p className="message message-ok">{message}</p>}

      {picked.size > 0 && (
        <section className="card sheet-move-bar">
          <strong>{picked.size} selected</strong>
          <label className="filter-field">
            <span className="field-label">Move to</span>
            <select
              className="sheet-move"
              value={moveTarget}
              disabled={busy}
              onChange={(event) => setMoveTarget(event.target.value)}
            >
              <option value="">Choose a fleet</option>
              <option value="new">New fleet</option>
              <option value="unassigned">Unassigned</option>
              {routes.map((route) => (
                <option key={route._id} value={route._id}>
                  {fleetLabel(route, (stopsByRoute.get(String(route._id)) || []).length)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !moveTarget}
            onClick={() => run(() => moveChosen([...picked], moveTarget))}
          >
            Move
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => {
              if (!window.confirm(`Delete ${picked.size} selected stop${picked.size === 1 ? '' : 's'}? Delivered stops stay.`)) return;
              run(async () => {
                const result = await deleteStops(dayId, { stopIds: [...picked] });
                setPicked(new Set());
                setMessage(`Deleted ${result.deleted} stop${result.deleted === 1 ? '' : 's'}.`);
              });
            }}
          >
            Delete stops
          </button>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setPicked(new Set())}>
            Clear
          </button>
        </section>
      )}

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
            <p className="hint">Tick the stops to move, or use the fleet list on each row. New fleet is for cargo that does not fit.</p>
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
                {cargoLabel(section.route?.loadingTotals) ? ` · ${cargoLabel(section.route?.loadingTotals)}` : ''}
                {section.route?.mapsStale ? ' · maps out of date' : (section.route?.mapSentAt ? ' · maps sent' : '')}
              </p>
            </div>
            <div className="row gap wrap">
              {section.stops.length > 0 && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => {
                    const allOn = section.stops.every((stop) => picked.has(stop._id));
                    selectFleet(section.stops, !allOn);
                  }}
                >
                  {section.stops.length > 0 && section.stops.every((stop) => picked.has(stop._id)) ? 'Clear selection' : 'Select these'}
                </button>
              )}
              {section.route && (
                <>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => openCustomise(section.route)}
                >
                  Customise
                </button>
                <select
                  key={menuKey}
                  className="sheet-move"
                  value=""
                  disabled={busy}
                  aria-label={`Delete options for ${section.title}`}
                  onChange={(event) => {
                    const choice = event.target.value;
                    setMenuKey((n) => n + 1);
                    if (choice) onFleetDelete(section, choice);
                  }}
                >
                  <option value="">Delete…</option>
                  {(section.route.mapSentAt || section.route.mapsFlag || section.route.mapsStale) && (
                    <option value="maps">Maps only</option>
                  )}
                  <option value="fleet">Fleet, keep the stops</option>
                  <option value="stops">Fleet and its stops</option>
                </select>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || section.stops.length === 0}
                  onClick={() => openAreaSend(section.route._id)}
                >
                  {section.route.mapsStale ? 'Send updated map' : 'Send fleet to driver'}
                </button>
                </>
              )}
            </div>
          </div>
          {section.route && customId === String(section.route._id) && (
            <form
              className="sheet-custom"
              onSubmit={(event) => {
                event.preventDefault();
                run(() => saveCustomise(section.route._id));
              }}
            >
              <label className="filter-field">
                <span className="field-label">Fleet name</span>
                <input value={fleetName} onChange={(event) => setFleetName(event.target.value)} required />
              </label>
              <label className="filter-field">
                <span className="field-label">Vehicle</span>
                <select value={vehicleId} onChange={(event) => setVehicleId(event.target.value)}>
                  <option value="">No vehicle</option>
                  {meta.vehicles.map((vehicle) => (
                    <option key={vehicle._id} value={vehicle._id}>
                      {[vehicle.type, vehicle.plate].filter(Boolean).join(' ')}
                    </option>
                  ))}
                </select>
              </label>
              <label className="filter-field">
                <span className="field-label">Driver</span>
                <select value={driverId} onChange={(event) => setDriverId(event.target.value)}>
                  <option value="">No driver</option>
                  {meta.drivers.map((driver) => (
                    <option key={driver._id} value={driver._id}>{driver.name}</option>
                  ))}
                </select>
              </label>
              <button type="submit" className="btn btn-primary" disabled={busy}>Save fleet</button>
            </form>
          )}
          {section.route?.mapsStale && (
            <p className="message message-warn sheet-map-warn">
              Stops moved after this map was sent. Delete the maps, then send this fleet again.
              The previous WhatsApp message is still on the driver’s phone.
            </p>
          )}
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
