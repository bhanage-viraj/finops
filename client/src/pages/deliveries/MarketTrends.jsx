import { useEffect, useState } from 'react';
import { fetchMarketTrends } from '../../api/deliveries.js';

const CHANNELS = [
  ['home', 'Home-based'],
  ['hotel', 'Hotel and villa'],
  ['restaurant', 'Restaurant'],
  ['depo', 'Depo'],
];

const KIND_LABEL = {
  gallon: 'Galon',
  glass: 'Galon kaca',
  bottle: 'Bottles',
  can: 'Cans',
  ice: 'Ice',
};

function formatCount(value) {
  return Number(value || 0).toLocaleString('id-ID');
}

function formatMonth(key, label) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(key || ''));
  if (!match) return label || '—';
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  return date.toLocaleDateString('id-ID', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function dayNumber(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return match ? String(Number(match[3])) : '';
}

function Trend({ rows, caption }) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  return (
    <div className="trend" role="img" aria-label={caption}>
      {rows.map((row) => (
        <div className="trend-col" key={row.key}>
          <span className="trend-value">{formatCount(row.value)}</span>
          <span
            className="trend-bar"
            style={{ height: `${Math.max(row.value > 0 ? 8 : 0, Math.round((row.value / max) * 120))}px` }}
          />
          <span className="trend-label">{row.label}</span>
        </div>
      ))}
    </div>
  );
}

export default function MarketTrends() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);

  function load(refresh = false) {
    setBusy(true);
    setError('');
    fetchMarketTrends(refresh)
      .then((body) => setData(body))
      .catch((err) => setError(err.message || 'The sheet could not be read.'))
      .finally(() => setBusy(false));
  }

  useEffect(() => {
    load(false);
  }, []);

  const months = data?.months || [];
  const month = data?.latestMonth;
  const monthName = month ? formatMonth(month.month, month.label) : '';
  const channelRows = CHANNELS.map(([key, label]) => ({
    key,
    label,
    value: month?.channels?.[key]?.gallons || 0,
  }));
  const monthBars = months.map((row) => ({
    key: row.month,
    label: formatMonth(row.month, row.label).split(' ')[0],
    value: row.gallons,
  }));
  const dayBars = (month?.byDay || []).map((row) => ({
    key: row.date,
    label: dayNumber(row.date),
    value: row.gallons,
  }));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Demand</h1>
          <p className="hint">
            Overall galon by month, from {data?.sourceName || 'LIST DRIVER 2026'}. The daily number is the average for that month.
          </p>
        </div>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => load(true)}>
          {busy ? 'Reading sheet…' : 'Reload sheet'}
        </button>
      </div>

      {error && <p className="message message-bad">{error}</p>}
      {busy && !month && !error && <p className="hint">Reading the driver lists…</p>}

      {month && (
        <>
          <div className="stat-grid demand-stats">
            <section className="card stat-card">
              <p className="field-label">Per day this month</p>
              <p className="stat-number">{formatCount(month.dailyAverage)}</p>
              <p className="hint">{monthName}</p>
            </section>
            <section className="card stat-card">
              <p className="field-label">Galon this month</p>
              <p className="stat-number">{formatCount(month.gallons)}</p>
              <p className="hint">
                {month.dayCount} day{month.dayCount === 1 ? '' : 's'} saved
                {month.qtyMissing > 0 ? ` · ${formatCount(month.qtyMissing)} lines have no quantity` : ''}
              </p>
            </section>
            <section className="card stat-card">
              <p className="field-label">High season</p>
              <p className="stat-number">{data.season?.ready ? formatCount(data.season.high.gallons) : '—'}</p>
              <p className="hint">{data.season?.ready ? formatMonth(data.season.high.month, data.season.high.label) : 'Needs two months'}</p>
            </section>
            <section className="card stat-card">
              <p className="field-label">Low season</p>
              <p className="stat-number">{data.season?.ready ? formatCount(data.season.low.gallons) : '—'}</p>
              <p className="hint">{data.season?.ready ? formatMonth(data.season.low.month, data.season.low.label) : 'Needs two months'}</p>
            </section>
          </div>

          <section className="card demand-section">
            <h2>{monthName}</h2>
            <p className="hint">Galon each day, for the whole company. Not split by area.</p>
            <Trend
              rows={dayBars}
              caption={`${monthName} galon by day. ${dayBars.map((row) => `${row.label} ${formatCount(row.value)}`).join(', ')}`}
            />
          </section>

          {months.length > 1 && (
            <section className="card demand-section">
              <h2>Months</h2>
              <p className="hint">Total galon in each month.</p>
              <Trend
                rows={monthBars}
                caption={monthBars.map((row) => `${row.label} ${formatCount(row.value)}`).join(', ')}
              />
            </section>
          )}

          <section className="card demand-section">
            <h2>By month</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Month</th>
                    <th className="num">Days</th>
                    <th className="num">Galon</th>
                    <th className="num">Per day</th>
                    <th className="num">Home</th>
                    <th className="num">Hotel</th>
                    <th className="num">Restaurant</th>
                    <th className="num">Depo</th>
                  </tr>
                </thead>
                <tbody>
                  {months.map((row) => (
                    <tr key={row.month}>
                      <td>{formatMonth(row.month, row.label)}</td>
                      <td className="num">{formatCount(row.dayCount)}</td>
                      <td className="num">{formatCount(row.gallons)}</td>
                      <td className="num">{formatCount(row.dailyAverage)}</td>
                      <td className="num">{formatCount(row.channels.home.gallons)}</td>
                      <td className="num">{formatCount(row.channels.hotel.gallons)}</td>
                      <td className="num">{formatCount(row.channels.restaurant.gallons)}</td>
                      <td className="num">{formatCount(row.channels.depo.gallons)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card demand-section">
            <h2>Who ordered in {monthName}</h2>
            <p className="hint">Galon in the month, from the customer name. Home, hotel, restaurant, and depo.</p>
            <div className="demand-bars">
              {channelRows.map((row) => {
                const top = Math.max(1, ...channelRows.map((item) => item.value));
                return (
                  <div className="demand-bar-row" key={row.key}>
                    <span>{row.label}</span>
                    <span className="demand-bar-track" aria-hidden="true">
                      <span className="demand-bar-fill" style={{ width: row.value > 0 ? `${Math.max(4, Math.round((row.value / top) * 100))}%` : '0%' }} />
                    </span>
                    <strong>{formatCount(row.value)}</strong>
                  </div>
                );
              })}
            </div>
            {month.newCustomers > 0 && (
              <p className="hint">{formatCount(month.newCustomers)} names marked Baru or New.</p>
            )}
          </section>

          <section className="card demand-section">
            <h2>Prepare or purchase</h2>
            <p className="hint">
              {monthName}
              {month.prepare.length > 0
                ? ` · per day ${month.prepare.map((row) => `${KIND_LABEL[row.kind] || row.kind} ${formatCount(Math.round(row.qty / month.dayCount))}`).join(', ')}`
                : ''}
            </p>
            {month.products.length === 0 ? (
              <p className="hint">No product quantities in this month yet.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th className="num">Month</th>
                      <th className="num">Per day</th>
                    </tr>
                  </thead>
                  <tbody>
                    {month.products.map((row) => (
                      <tr key={row.name}>
                        <td>{row.name}</td>
                        <td className="num">{formatCount(row.qty)}</td>
                        <td className="num">{formatCount(Math.round(row.qty / month.dayCount))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <p className="hint">{data.season?.note}</p>
          <p className="hint">
            <a href={data.sheetUrl} target="_blank" rel="noreferrer">Open LIST DRIVER 2026</a>
          </p>
        </>
      )}
    </>
  );
}
