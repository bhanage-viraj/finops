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
  downloadDayExport,
  clearRouteMaps,
  deleteStops,
  clearStopMaps,
  updateRoute,
  updateStop,
} from '../../api/deliveries.js';
import StatusBadge from '../../components/StatusBadge.jsx';
import { formatRupiah } from '../../utils/formatRupiah.js';
import LocationMap from './LocationMap.jsx';

function mapsUrl(stop) {
  const loc = stop.location || {};
  if (loc.hideMap) return '';
  const raw = String(loc.mapsUrl || '').trim();
  const short = raw.match(/https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps)\/[\w-]+/i);
  if (short) return short[0];
  if (/^https:\/\/maps\.google\.com\/\?q=/i.test(raw) && !/\s/.test(raw)) return raw;
  if (loc.lat != null && loc.lng != null && Number.isFinite(Number(loc.lat)) && Number.isFinite(Number(loc.lng))) {
    const lat = Math.round(Number(loc.lat) * 1e6) / 1e6;
    const lng = Math.round(Number(loc.lng) * 1e6) / 1e6;
    return `https://maps.google.com/?q=${lat}%2C${lng}`;
  }
  if (raw && !/%20/i.test(raw) && !/\s/.test(raw)) return raw;
  const text = [loc.placeName, loc.address].filter(Boolean).join(' ');
  if (!text) return '';
  const query = text.replace(/[,;]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').map(encodeURIComponent).join('+');
  return `https://maps.google.com/?q=${query}`;
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
  if (stopCount != null) bits.push(`${stopCount} deliveries`);
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

function wholeQty(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (!/^\d+$/.test(text)) throw new Error('Quantity must be a whole number.');
  return Number(text);
}

function draftFromStop(stop) {
  const items = (stop.plannedItems || []).map((item, index) => ({
    key: `${index}-${item.productName || 'item'}`,
    productName: item.productName || '',
    packType: item.packType || '',
    qty: item.qty == null ? '' : String(item.qty),
  }));
  return {
    customerName: stop.customerName || '',
    note: stop.note || '',
    address: stop.location?.address || '',
    mapsUrl: stop.location?.mapsUrl || '',
    routeId: stop.routeId ? String(stop.routeId) : 'unassigned',
    items: items.length ? items : [{ key: 'new', productName: '', packType: '', qty: '' }],
  };
}

function keptOnSheet(stop) {
  return stop.status === 'delivered' || stop.status === 'nota_checked';
}

export default function DayDetail() {
  const { dayId } = useParams();
  const navigate = useNavigate();
  const [day, setDay] = useState(null);
  const [routes, setRoutes] = useState([]);
  const [stops, setStops] = useState([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [sendQueue, setSendQueue] = useState([]);
  const [preview, setPreview] = useState(null);
  const [picked, setPicked] = useState(() => new Set());
  const [moveTarget, setMoveTarget] = useState('');
  const [meta, setMeta] = useState({ vehicles: [], drivers: [] });
  const [customId, setCustomId] = useState('');
  const [fleetName, setFleetName] = useState('');
  const [vehicleId, setVehicleId] = useState('');
  const [driverId, setDriverId] = useState('');
  const [editId, setEditId] = useState('');
  const [draft, setDraft] = useState(null);
  const [moving, setMoving] = useState(false);
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
    setEditId('');
    setDraft(null);
    setMoving(false);
    load().catch((err) => setError(err.message));
    fetchDeliveryMeta().then((body) => {
      setMeta({ vehicles: body.vehicles || [], drivers: body.drivers || [] });
    }).catch(() => {});
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
      title: route.areaName || 'Fleet',
      stops: stopsByRoute.get(String(route._id)) || [],
    }));
    const loose = stopsByRoute.get('none') || [];
    if (loose.length) {
      sections.push({
        key: 'none',
        route: null,
        title: 'Not on a fleet',
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
    setEditId('');
    setDraft(null);
    setCustomId(String(route._id));
    setFleetName(route.areaName || '');
    setVehicleId(route.vehicleId ? String(route.vehicleId) : '');
    setDriverId(route.driverIds?.[0] ? String(route.driverIds[0]) : '');
  }

  function openDelivery(stop) {
    setCustomId('');
    if (editId === stop._id) {
      setEditId('');
      setDraft(null);
      return;
    }
    setEditId(stop._id);
    setDraft(draftFromStop(stop));
  }

  async function saveCustomise(routeId) {
    await updateRoute(routeId, {
      areaName: fleetName,
      vehicleId: vehicleId || null,
      driverIds: driverId ? [driverId] : [],
    });
    setCustomId('');
  }

  async function moveChosen(stopIds, routeId) {
    const result = await moveStops(dayId, { stopIds, routeId });
    setPicked(new Set());
    setMoveTarget('');
    setMessage(result.mapsStale
      ? 'Moved. Clear the sent map on that fleet, then send it again.'
      : `Moved ${result.moved} ${result.moved === 1 ? 'delivery' : 'deliveries'}.`);
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

  async function saveDelivery(stop) {
    const result = await updateStop(stop._id, {
      customerName: draft.customerName,
      note: draft.note,
      address: draft.address,
      mapsUrl: draft.mapsUrl,
      plannedItems: draft.items.map((item) => ({
        productName: item.productName,
        packType: item.packType,
        qty: wholeQty(item.qty),
      })),
    });
    const nextUrl = draft.mapsUrl.trim();
    const prevUrl = stop.location?.mapsUrl || '';
    if (nextUrl && nextUrl !== prevUrl) {
      try {
        await setStopLocation(stop._id, { mapsUrl: nextUrl, address: draft.address });
      } catch {
        // The link is already stored. A pin is filled when the link can be read.
      }
    }
    const current = stop.routeId ? String(stop.routeId) : 'unassigned';
    let movedStale = false;
    if (draft.routeId !== current) {
      const moved = await moveStops(dayId, { stopIds: [stop._id], routeId: draft.routeId });
      movedStale = Boolean(moved.mapsStale);
    }
    setEditId('');
    setDraft(null);
    setMessage(result.mapsStale || movedStale
      ? 'Saved. Clear the sent map on that fleet, then send it again.'
      : 'Delivery saved.');
  }

  async function openAreaSend(routeId) {
    setBusy(true);
    setError('');
    try {
      const msg = await fetchRouteMessage(routeId);
      setPreview({ routeId, ...msg });
      await markMapSent(routeId);
      window.open(msg.whatsappUrl, '_blank', 'noopener,noreferrer');
      setMessage('WhatsApp opened for this fleet. The maps are in the message.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function startSendAllAreas() {
    const ids = routes.map((route) => String(route._id));
    if (!ids.length) {
      setError('No fleets to send.');
      return;
    }
    setSendQueue(ids.slice(1));
    await openAreaSend(ids[0]);
    if (ids.length > 1) {
      setMessage(`Opened fleet 1 of ${ids.length}. Send the next fleet when this chat is done.`);
    }
  }

  async function sendNextArea() {
    if (!sendQueue.length) return;
    const [next, ...rest] = sendQueue;
    setSendQueue(rest);
    await openAreaSend(next);
    if (rest.length) {
      setMessage(`${rest.length} ${rest.length === 1 ? 'fleet' : 'fleets'} left.`);
    } else {
      setMessage('Every fleet has been opened in WhatsApp.');
    }
  }

  async function onNota(stopId, file) {
    if (!file) return;
    await run(async () => {
      const result = await uploadNota(stopId, file, false);
      if (result?.nota?._id || result?.stop) {
        try {
          await confirmNota(stopId, {});
        } catch {
          // Keep the draft when a person still has to confirm it.
        }
      }
    }, 'Receipt uploaded.');
  }

  function deleteMaps(ids) {
    const count = ids.length;
    if (!window.confirm(`Delete the map for ${count} ${count === 1 ? 'delivery' : 'deliveries'}? The deliveries stay.`)) return;
    run(async () => {
      const result = await clearStopMaps(dayId, { stopIds: ids });
      setPicked((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
      if (ids.includes(editId)) {
        setDraft((current) => (current ? { ...current, mapsUrl: '' } : current));
      }
      setMessage(result.mapsStale
        ? 'Map deleted. Clear the sent map on that fleet, then send it again.'
        : 'Map deleted.');
    });
  }

  function clearSentMap(route, title) {
    if (!window.confirm(`Clear the sent map for ${title}? The deliveries stay.`)) return;
    run(() => clearRouteMaps(route._id), 'Sent map cleared. Send this fleet again when the load is right.');
  }

  async function onDeleteSheet() {
    if (!window.confirm(`Delete the sheet for ${day?.date || 'this day'}? This removes the fleets and the deliveries.`)) return;
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

  function setItem(key, patch) {
    setDraft((current) => ({
      ...current,
      items: current.items.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    }));
  }

  if (!day) {
    return (
      <div className="page">
        <p className="hint">Loading…</p>
        {error && <p className="message message-bad">{error}</p>}
      </div>
    );
  }

  const deliveryCount = day.summary?.stopCount ?? stops.length;

  return (
    <div className="page sheet-page">
      <header className="page-header">
        <div>
          <p className="hint"><Link to="/deliver">Deliver</Link></p>
          <h1>{day.date}</h1>
          <p className="hint">
            {deliveryCount} {deliveryCount === 1 ? 'delivery' : 'deliveries'}
            {' · '}
            {routes.length} {routes.length === 1 ? 'fleet' : 'fleets'}
            {' · '}
            <StatusBadge status={day.status} />
          </p>
          <p className="hint">
            {moving
              ? 'Tick a delivery, then move it or delete its map.'
              : 'Tap a delivery to change it. Send the fleet when the load is right.'}
          </p>
        </div>
        <div className="row gap wrap">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => {
              setMoving((on) => !on);
              setPicked(new Set());
              setMoveTarget('');
            }}
          >
            {moving ? 'Done' : 'Move deliveries'}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => run(() => downloadDayExport(dayId), 'Excel downloaded. Each area is its own tab.')}
          >
            Download Excel
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => run(async () => { await syncCartrack(dayId); }, 'Statuses refreshed from Cartrack.')}
          >
            Sync Cartrack
          </button>
          {sendQueue.length > 0 && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={sendNextArea}>
              Send next fleet ({sendQueue.length} left)
            </button>
          )}
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy || !routes.length}
            onClick={startSendAllAreas}
          >
            Send all fleets
          </button>
        </div>
      </header>

      {error && <p className="message message-bad">{error}</p>}
      {message && <p className="message message-ok">{message}</p>}

      {picked.size > 0 && (
        <section className="card delivery-move">
          <div>
            <strong>{picked.size} selected</strong>
            <p className="hint">Move them if the fleet is too full, or delete their maps. The deliveries stay.</p>
          </div>
          <div className="delivery-actions">
            <label className="field">
              <span className="field-label">Move to</span>
              <select value={moveTarget} disabled={busy} onChange={(event) => setMoveTarget(event.target.value)}>
                <option value="">Choose a fleet</option>
                <option value="new">New fleet</option>
                <option value="unassigned">Not on a fleet</option>
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
              onClick={() => deleteMaps([...picked])}
            >
              Delete
            </button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setPicked(new Set())}>
              Clear
            </button>
          </div>
        </section>
      )}

      {preview && (
        <section className="card delivery-preview-card">
          <div className="row gap wrap" style={{ justifyContent: 'space-between' }}>
            <p className="hint" style={{ margin: 0 }}>
              Message for the driver
              {preview.needsCheck ? ` · ${preview.needsCheck} still need a location` : ''}
            </p>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => navigator.clipboard.writeText(preview.text)}
            >
              Copy message
            </button>
          </div>
          <pre className="delivery-preview">{preview.text}</pre>
        </section>
      )}

      {areaSections.map((section) => {
        const editingHere = section.stops.some((stop) => stop._id === editId);
        const allOn = section.stops.length > 0 && section.stops.every((stop) => picked.has(stop._id));
        const detail = [
          `${section.stops.length} ${section.stops.length === 1 ? 'delivery' : 'deliveries'}`,
          section.route?.vehicleLabel,
          (section.route?.driverNames || []).filter(Boolean).join(' & '),
          cargoLabel(section.route?.loadingTotals),
        ].filter(Boolean).join(' · ');
        const mapSent = Boolean(section.route?.mapSentAt || section.route?.mapsFlag);
        return (
          <section key={section.key} className="card sheet-board">
            <div className="fleet-head">
              <div>
                <h2>{section.title}</h2>
                <p className="hint">{section.route ? detail : 'Choose a fleet inside each delivery.'}</p>
                {section.route && !section.route.mapsStale && (
                  <p className="hint">{mapSent ? 'Map sent. The driver already has that message.' : 'No map sent yet.'}</p>
                )}
              </div>
              <div className="fleet-actions">
                {section.route && (
                  <button
                    type="button"
                    className={editingHere ? 'btn btn-secondary' : 'btn btn-primary'}
                    disabled={busy || section.stops.length === 0}
                    onClick={() => openAreaSend(section.route._id)}
                  >
                    {section.route.mapsStale ? 'Send updated map' : 'Send to driver'}
                  </button>
                )}
              </div>
            </div>
            {section.route && (
              <div className="fleet-links">
                <button
                  type="button"
                  className="linkish"
                  disabled={busy}
                  onClick={() => (customId === String(section.route._id) ? setCustomId('') : openCustomise(section.route))}
                >
                  {customId === String(section.route._id) ? 'Close' : 'Change fleet'}
                </button>
                {moving && section.stops.length > 0 && (
                  <button
                    type="button"
                    className="linkish"
                    disabled={busy}
                    onClick={() => selectFleet(section.stops, !allOn)}
                  >
                    {allOn ? 'Clear selection' : 'Select all'}
                  </button>
                )}
                {mapSent && !section.route.mapsStale && (
                  <button
                    type="button"
                    className="linkish"
                    disabled={busy}
                    onClick={() => clearSentMap(section.route, section.title)}
                  >
                    Clear sent map
                  </button>
                )}
              </div>
            )}

            {section.route && customId === String(section.route._id) && (
              <form
                className="delivery-edit"
                onSubmit={(event) => {
                  event.preventDefault();
                  run(() => saveCustomise(section.route._id), 'Fleet saved.');
                }}
              >
                <div className="delivery-fields">
                  <label className="field">
                    <span className="field-label">Fleet name</span>
                    <input value={fleetName} onChange={(event) => setFleetName(event.target.value)} required />
                  </label>
                  <label className="field">
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
                  <label className="field">
                    <span className="field-label">Driver</span>
                    <select value={driverId} onChange={(event) => setDriverId(event.target.value)}>
                      <option value="">No driver</option>
                      {meta.drivers.map((driver) => (
                        <option key={driver._id} value={driver._id}>{driver.name}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="delivery-actions">
                  <button type="submit" className="btn btn-primary" disabled={busy}>Save fleet</button>
                </div>
              </form>
            )}

            {section.route?.mapsStale && (
              <p className="message message-warn sheet-map-warn">
                This load changed after the map was sent.{' '}
                <button
                  type="button"
                  className="linkish"
                  disabled={busy}
                  onClick={() => clearSentMap(section.route, section.title)}
                >
                  Clear the sent map
                </button>
                {' '}then send it again. The old WhatsApp message is still on the driver’s phone.
              </p>
            )}

            <ul className="delivery-list">
              {section.stops.map((stop, index) => {
                const open = editId === stop._id && draft;
                const url = mapsUrl(stop);
                return (
                  <li key={stop._id} className={stop.location?.needsPin ? 'delivery-item needs-pin' : 'delivery-item'}>
                    <div className={['delivery-row', open ? 'is-open' : '', moving ? '' : 'no-pick', moving && picked.has(stop._id) ? 'has-delete' : ''].filter(Boolean).join(' ')}>
                      {moving && (
                        <label className="delivery-pick">
                          <input
                            type="checkbox"
                            checked={picked.has(stop._id)}
                            aria-label={`Select ${stop.customerName}`}
                            onChange={() => togglePicked(stop._id)}
                          />
                        </label>
                      )}
                      <button
                        type="button"
                        className="delivery-main"
                        aria-expanded={open ? 'true' : 'false'}
                        onClick={() => openDelivery(stop)}
                      >
                        <span className="delivery-title">
                          <strong>{index + 1}. {stop.customerName}</strong>
                          {stop.isNewCustomer && <span className="badge badge-warn">New</span>}
                          {stop.location?.needsPin && <span className="badge badge-warn">Check location</span>}
                          {stop.location?.hideMap && <span className="badge badge-neutral">No map</span>}
                          <span className="delivery-edit-cue">{open ? 'Close' : 'Edit'}</span>
                        </span>
                        <span className="muted">{stop.location?.address || stop.location?.placeName || 'No address yet'}</span>
                        <span className="muted">{itemsLabel(stop) || 'No products yet'}</span>
                      </button>
                      {moving && picked.has(stop._id) && (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={busy || stop.location?.hideMap}
                          onClick={() => deleteMaps([stop._id])}
                        >
                          Delete
                        </button>
                      )}
                      <StatusBadge status={stop.status} />
                    </div>

                    {open && (
                      <form
                        className="delivery-edit"
                        onSubmit={(event) => {
                          event.preventDefault();
                          run(() => saveDelivery(stop));
                        }}
                      >
                        <div className="delivery-fields">
                          <label className="field">
                            <span className="field-label">Customer</span>
                            <input
                              value={draft.customerName}
                              onChange={(event) => setDraft({ ...draft, customerName: event.target.value })}
                              required
                            />
                          </label>
                          <label className="field">
                            <span className="field-label">Fleet</span>
                            <select
                              value={draft.routeId}
                              onChange={(event) => setDraft({ ...draft, routeId: event.target.value })}
                            >
                              <option value="new">New fleet</option>
                              <option value="unassigned">Not on a fleet</option>
                              {routes.map((route) => (
                                <option key={route._id} value={route._id}>
                                  {fleetLabel(route, (stopsByRoute.get(String(route._id)) || []).length)}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="field delivery-span">
                            <span className="field-label">Address</span>
                            <input
                              value={draft.address}
                              onChange={(event) => setDraft({ ...draft, address: event.target.value })}
                            />
                          </label>
                          <label className="field delivery-span">
                            <span className="field-label">Map link</span>
                            <input
                              value={draft.mapsUrl}
                              placeholder="Paste a Google Maps link"
                              onChange={(event) => setDraft({ ...draft, mapsUrl: event.target.value })}
                            />
                            <span className="hint">
                              {stop.location?.hideMap
                                ? 'This map is deleted. Paste a new link and save to put it back.'
                                : 'Blank keeps the pin already saved for this customer.'}
                            </span>
                          </label>
                          <label className="field delivery-span">
                            <span className="field-label">Note</span>
                            <textarea
                              value={draft.note}
                              onChange={(event) => setDraft({ ...draft, note: event.target.value })}
                            />
                          </label>
                        </div>

                        <div>
                          <span className="field-label">Products</span>
                          {draft.items.map((item, itemIndex) => (
                            <div key={item.key} className="delivery-line">
                              <label className="field">
                                <span className="field-label">Product</span>
                                <input
                                  aria-label={`Product ${itemIndex + 1}`}
                                  value={item.productName}
                                  onChange={(event) => setItem(item.key, { productName: event.target.value })}
                                />
                              </label>
                              <label className="field">
                                <span className="field-label">Qty</span>
                                <input
                                  aria-label={`Quantity ${itemIndex + 1}`}
                                  inputMode="numeric"
                                  value={item.qty}
                                  onChange={(event) => setItem(item.key, { qty: event.target.value })}
                                />
                              </label>
                              <button
                                type="button"
                                className="btn btn-secondary"
                                disabled={busy}
                                onClick={() => setDraft((current) => {
                                  const items = current.items.filter((row) => row.key !== item.key);
                                  return {
                                    ...current,
                                    items: items.length ? items : [{ key: 'new', productName: '', packType: '', qty: '' }],
                                  };
                                })}
                              >
                                Remove product
                              </button>
                            </div>
                          ))}
                          <button
                            type="button"
                            className="btn btn-secondary"
                            disabled={busy}
                            onClick={() => setDraft((current) => ({
                              ...current,
                              items: [...current.items, {
                                key: `new-${current.items.length}-${Date.now()}`,
                                productName: '',
                                packType: '',
                                qty: '',
                              }],
                            }))}
                          >
                            Add product
                          </button>
                        </div>

                        {stop.location?.needsPin && (
                          <LocationMap
                            initial={stop.location?.lat != null ? { lat: stop.location.lat, lng: stop.location.lng } : null}
                            onPick={(coords) => run(
                              () => setStopLocation(stop._id, coords),
                              'Location saved.',
                            )}
                          />
                        )}

                        <div className="delivery-actions">
                          <button type="submit" className="btn btn-primary" disabled={busy}>Save delivery</button>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            disabled={busy || stop.location?.hideMap}
                            onClick={() => deleteMaps([stop._id])}
                          >
                            Delete map
                          </button>
                          {url && (
                            <a className="btn btn-secondary" href={url} target="_blank" rel="noreferrer">Open map</a>
                          )}
                          <button
                            type="button"
                            className="btn btn-secondary"
                            disabled={busy}
                            onClick={() => notaRefs.current[stop._id]?.click()}
                          >
                            Upload receipt
                          </button>
                          <input
                            ref={(el) => { notaRefs.current[stop._id] = el; }}
                            type="file"
                            accept="image/*"
                            hidden
                            onChange={(event) => {
                              const file = event.target.files?.[0];
                              event.target.value = '';
                              if (file) onNota(stop._id, file);
                            }}
                          />
                          <button
                            type="button"
                            className="linkish"
                            disabled={busy}
                            onClick={() => run(
                              () => setStopStatus(stop._id, {
                                status: stop.status === 'delivered' ? 'otw' : 'delivered',
                                source: 'admin',
                              }),
                              'Status updated.',
                            )}
                          >
                            {stop.status === 'delivered' || stop.status === 'nota_checked' ? 'Undo delivered' : 'Mark delivered'}
                          </button>
                          {keptOnSheet(stop) ? (
                            <span className="hint">A delivered stop stays on the sheet.</span>
                          ) : (
                            <button
                              type="button"
                              className="linkish"
                              disabled={busy}
                              onClick={() => {
                                if (!window.confirm(`Remove ${stop.customerName} from this day? The fleet stays.`)) return;
                                run(async () => {
                                  await deleteStops(dayId, { stopIds: [stop._id] });
                                  setEditId('');
                                  setDraft(null);
                                  setPicked((prev) => {
                                    const next = new Set(prev);
                                    next.delete(stop._id);
                                    return next;
                                  });
                                }, 'That delivery was removed. The fleet is still here.');
                              }}
                            >
                              Remove this delivery
                            </button>
                          )}
                        </div>
                      </form>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}

      {areaSections.length === 0 && (
        <p className="hint">No deliveries on this day yet.</p>
      )}

      <p className="delivery-footer">
        <button type="button" className="linkish" disabled={busy} onClick={onDeleteSheet}>
          Delete this day’s sheet
        </button>
      </p>
    </div>
  );
}
