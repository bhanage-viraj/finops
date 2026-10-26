import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchDaySpeed, fetchFleetSpeed } from '../../api/deliveries.js';

const WITA_MS = 8 * 60 * 60 * 1000;
const CHART_HEIGHT = 228;

function joinNames(names) {
  if (names.length <= 1) return names[0] || '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function hm(ms) {
  const local = new Date(ms + WITA_MS);
  const hh = String(local.getUTCHours()).padStart(2, '0');
  const mm = String(local.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function chartModel(points, limitKmh) {
  const times = points
    .map((point) => new Date(point.at).getTime())
    .filter((time) => Number.isFinite(time));
  if (!times.length) return null;
  let t0 = Math.min(...times);
  let t1 = Math.max(...times);
  if (t1 - t0 < 30 * 60 * 1000) {
    const pad = (30 * 60 * 1000 - (t1 - t0)) / 2;
    t0 -= pad;
    t1 += pad;
  }
  const peak = Math.max(limitKmh, ...points.map((point) => Number(point.speed) || 0));
  let yMax = Math.max(35, Math.ceil(peak / 5) * 5);
  if (peak >= yMax) yMax += 5;
  return { t0, t1, yMax };
}

function timeTicks(t0, t1) {
  const spanMin = (t1 - t0) / 60000;
  const stepMin = spanMin > 240 ? 60 : spanMin > 90 ? 30 : 15;
  const step = stepMin * 60000;
  const ticks = [];
  let local = Math.ceil((t0 + WITA_MS) / step) * step;
  while (local < t1 + WITA_MS) {
    const t = local - WITA_MS;
    if (t > t0 + step * 0.2 && t < t1 - step * 0.05) ticks.push({ t, label: hm(t) });
    local += step;
  }
  if (ticks.length < 2) return [{ t: t0, label: hm(t0) }, { t: t1, label: hm(t1) }];
  return ticks;
}

function useBoxWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function SpeedChart({ vehicle, limitKmh }) {
  const [ref, width] = useBoxWidth();
  const points = vehicle.points || [];
  const model = chartModel(points, limitKmh);
  const peak = vehicle.maxSpeed == null ? 'no reading' : `peak ${vehicle.maxSpeed} km/h`;
  const state = vehicle.currentSpeed > limitKmh || vehicle.overLimit
    ? `above ${limitKmh}`
    : `under ${limitKmh}`;
  const aria = `${vehicle.plate} speed, ${peak}, ${state}.`;

  let drawing = null;
  if (model && width > 0) {
    const plotWidth = Math.max(width, 280);
    const padL = 36;
    const padR = 8;
    const padT = 8;
    const padB = 48;
    const plotW = Math.max(plotWidth - padL - padR, 40);
    const plotH = CHART_HEIGHT - padT - padB;
    const { t0, t1, yMax } = model;
    const xOf = (t) => padL + ((t - t0) / (t1 - t0)) * plotW;
    const yOf = (speed) => padT + (1 - Math.max(0, Math.min(yMax, speed)) / yMax) * plotH;
    const step = yMax > 60 ? 10 : 5;
    const grid = [];
    for (let value = 0; value <= yMax; value += step) grid.push(value);
    const coords = points.map((point) => {
      const t = new Date(point.at).getTime();
      return `${xOf(t).toFixed(1)},${yOf(point.speed).toFixed(1)}`;
    }).join(' ');
    const last = points[points.length - 1];
    drawing = (
      <svg
        className="speed-chart"
        viewBox={`0 0 ${plotWidth} ${CHART_HEIGHT}`}
        role="img"
        aria-label={aria}
      >
        <title>{aria}</title>
        {grid.map((value) => {
          const y = yOf(value);
          const mark = value === limitKmh;
          return (
            <g key={value}>
              <line
                x1={padL}
                x2={padL + plotW}
                y1={y}
                y2={y}
                stroke={mark ? 'var(--bad-ink)' : 'var(--border)'}
                strokeDasharray={mark ? '4 3' : undefined}
              />
              <text
                x={padL - 6}
                y={y + 3}
                textAnchor="end"
                fontSize="11"
                fontFamily="Public Sans, Arial, sans-serif"
                fill={mark ? 'var(--bad-ink)' : 'var(--muted)'}
                fontWeight={mark ? 700 : 400}
              >
                {value}
              </text>
            </g>
          );
        })}
        {points.length > 1 && (
          <polyline
            points={coords}
            fill="none"
            stroke="var(--bad-ink)"
            strokeWidth="1.75"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
        {points.length === 1 && (
          <circle cx={xOf(new Date(last.at).getTime())} cy={yOf(last.speed)} r="3.5" fill="var(--bad-ink)" />
        )}
        {timeTicks(t0, t1).map((tick) => (
          <text
            key={tick.label + tick.t}
            x={xOf(tick.t)}
            y={padT + plotH + 16}
            textAnchor="middle"
            fontSize="11"
            fontFamily="Public Sans, Arial, sans-serif"
            fill="var(--muted)"
          >
            {tick.label}
          </text>
        ))}
        <rect x={padL} y={CHART_HEIGHT - 16} width={plotW} height="8" rx="2" fill="var(--accent-soft)" />
      </svg>
    );
  }

  return (
    <div className={points.length ? 'speed-plot' : 'speed-plot is-empty'} ref={ref}>
      {points.length ? drawing : <p className="hint">No speed from Cartrack yet.</p>}
    </div>
  );
}

function badgeFor(vehicle, limit) {
  if (vehicle.currentSpeed > limit) return { kind: 'bad', text: `Now ${vehicle.currentSpeed} km/h` };
  if (vehicle.overLimit) return { kind: 'bad', text: `Above ${limit} · peak ${vehicle.maxSpeed}` };
  if (!vehicle.points?.length && vehicle.maxSpeed == null) return { kind: 'neutral', text: 'No speed yet' };
  return { kind: 'ok', text: `Under ${limit}` };
}

export default function SpeedCharts({ dayId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const run = useRef(0);

  const load = useCallback(async () => {
    const token = run.current + 1;
    run.current = token;
    try {
      const body = dayId ? await fetchDaySpeed(dayId) : await fetchFleetSpeed();
      if (run.current === token) {
        setData(body);
        setError('');
      }
      return body;
    } catch (err) {
      if (run.current === token) setError(err.message);
      return null;
    } finally {
      if (run.current === token) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [dayId]);

  useEffect(() => {
    let timer = null;
    let stopped = false;
    async function tick() {
      const body = await load();
      if (stopped) return;
      if (body?.refresh && !timer) timer = setInterval(tick, 60_000);
      if (body && !body.refresh && timer) {
        clearInterval(timer);
        timer = null;
      }
    }
    setLoading(true);
    setData(null);
    setError('');
    tick();
    return () => {
      stopped = true;
      run.current += 1;
      if (timer) clearInterval(timer);
    };
  }, [load]);

  const limit = data?.limitKmh || 30;
  const vehicles = data?.vehicles || [];
  const live = vehicles.filter((vehicle) => vehicle.currentSpeed > limit);
  const past = vehicles.filter((vehicle) => vehicle.overLimit && !(vehicle.currentSpeed > limit));
  const liveText = live.length
    ? `${joinNames(live.map((vehicle) => `${vehicle.plate} is at ${vehicle.currentSpeed} km/h`))}, above ${limit}.`
    : '';
  const pastText = past.length
    ? `${joinNames(past.map((vehicle) => vehicle.plate))} went above ${limit} km/h.`
    : '';
  const failed = vehicles.length > 0 && vehicles.every((vehicle) => vehicle.error);

  return (
    <section className="speed-section" aria-label="Speed">
      <div className="speed-head">
        <div>
          <h2>Speed</h2>
          <p className="hint">
            {data?.from && data.to && data.from !== data.to
              ? `${data.from}–${data.to}. Every car from Cartrack, with or without a delivery. Above ${limit} km/h is marked.`
              : `Every car from Cartrack, with or without a delivery. Above ${limit} km/h is marked.`}
          </p>
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={loading || refreshing}
          onClick={() => {
            setRefreshing(true);
            load();
          }}
        >
          {refreshing ? 'Refreshing…' : 'Refresh speed'}
        </button>
      </div>

      {error && <p className="message message-bad">{error}</p>}
      {liveText && <p className="message message-bad">{liveText}</p>}
      {!liveText && pastText && <p className="message message-warn">{pastText}</p>}
      {data?.note && (
        failed
          ? <p className="message message-bad">{data.note}</p>
          : <p className="hint">{data.note}</p>
      )}
      {loading && !data && <p className="hint">Reading speed from Cartrack…</p>}

      <div className="speed-grid">
        {vehicles.map((vehicle) => {
          const badge = badgeFor(vehicle, limit);
          const extra = vehicle.burstCount > (vehicle.bursts || []).length
            ? vehicle.burstCount - vehicle.bursts.length
            : 0;
          return (
            <article key={vehicle.plate} className="card speed-card">
              <div className="speed-card-head">
                <div>
                  <p className="speed-plate">{vehicle.plate}</p>
                  {vehicle.areaName && <p className="hint">{vehicle.areaName}</p>}
                </div>
                <span className={`badge badge-${badge.kind}`}>{badge.text}</span>
              </div>
              <SpeedChart vehicle={vehicle} limitKmh={limit} />
              {vehicle.bursts?.length > 0 && (
                <p className="hint speed-bursts">
                  {vehicle.bursts.map((burst) => burst.label).join(' · ')}
                  {extra > 0 ? ` · +${extra} more` : ''}
                </p>
              )}
              {!vehicle.overLimit && vehicle.maxSpeed != null && (
                <p className="hint speed-bursts">Peak {vehicle.maxSpeed} km/h</p>
              )}
              {vehicle.error && vehicle.error !== data?.note && (
                <p className="hint speed-bursts">{vehicle.error}</p>
              )}
              {vehicle.truncated && (
                <p className="hint">Some older readings did not fit on this graph.</p>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
