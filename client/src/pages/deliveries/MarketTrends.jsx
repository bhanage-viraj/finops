import { useEffect, useState } from 'react';
import { fetchSales } from '../../api/deliveries.js';
import { formatRupiah } from '../../utils/formatRupiah.js';

const CHANNELS = [
  ['home', 'Home-based'],
  ['hotel', 'Hotel and villa'],
  ['restaurant', 'Restaurant'],
  ['depo', 'Depo'],
];

function formatCount(value) {
  return Number(value || 0).toLocaleString('id-ID');
}

function formatMonth(key, label) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(key || ''));
  if (!match) return label || '—';
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  return date.toLocaleDateString('id-ID', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function Trend({ rows, caption }) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  return (
    <div className="trend" role="img" aria-label={caption}>
      {rows.map((row) => (
        <div className="trend-col" key={row.key}>
          <span className="trend-bar" style={{ height: `${Math.max(row.value > 0 ? 8 : 0, Math.round((row.value / max) * 120))}px` }} />
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
    fetchSales(refresh)
      .then((body) => setData(body))
      .catch((err) => setError(err.message || 'Zoho sales could not be read.'))
      .finally(() => setBusy(false));
  }

  useEffect(() => {
    load(false);
  }, []);

  const months = data?.months || [];
  const month = data?.latestMonth;
  const monthName = month ? formatMonth(month.month, month.label) : '';
  const monthBars = months.map((row) => ({
    key: row.month,
    label: formatMonth(row.month, row.label).split(' ')[0],
    value: row.total,
  }));
  const channelRows = CHANNELS.map(([key, label]) => ({
    key,
    label,
    value: month?.channels?.[key]?.total || 0,
  }));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Demand</h1>
          <p className="hint">
            All sales from Zoho Books, by month. Paid and still unpaid invoices are included. Drafts and voids are left out.
          </p>
        </div>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => load(true)}>
          {busy ? 'Reading Zoho…' : 'Reload Zoho'}
        </button>
      </div>

      {error && <p className="message message-bad">{error}</p>}
      {data?.truncated && (
        <p className="message message-warn">Zoho did not return every invoice. These totals can be short.</p>
      )}
      {busy && !month && !error && <p className="hint">Reading every sale from Zoho. The first time can take a minute.</p>}

      {month && (
        <>
          <div className="stat-grid demand-stats">
            <section className="card stat-card">
              <p className="field-label">Sales this month</p>
              <p className="stat-number">{formatRupiah(month.total)}</p>
              <p className="hint">{monthName} · {formatCount(month.count)} invoices</p>
            </section>
            <section className="card stat-card">
              <p className="field-label">Per selling day</p>
              <p className="stat-number">{formatRupiah(month.dailyAverage)}</p>
              <p className="hint">{formatCount(month.dayCount)} days with a sale</p>
            </section>
            <section className="card stat-card">
              <p className="field-label">High season</p>
              <p className="stat-number">{data.season?.ready ? formatRupiah(data.season.high.total) : '—'}</p>
              <p className="hint">{data.season?.ready ? formatMonth(data.season.high.month, data.season.high.label) : 'Needs two full months'}</p>
            </section>
            <section className="card stat-card">
              <p className="field-label">Low season</p>
              <p className="stat-number">{data.season?.ready ? formatRupiah(data.season.low.total) : '—'}</p>
              <p className="hint">{data.season?.ready ? formatMonth(data.season.low.month, data.season.low.label) : 'Needs two full months'}</p>
            </section>
          </div>

          <section className="card demand-section">
            <h2>Sales by month</h2>
            <p className="hint">
              {formatRupiah(data.total)} across {formatCount(data.invoiceCount)} invoices.
            </p>
            <Trend
              rows={monthBars}
              caption={monthBars.map((row) => `${row.label} ${formatRupiah(row.value)}`).join(', ')}
            />
          </section>

          <section className="card demand-section">
            <h2>By month</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Month</th>
                    <th className="num">Invoices</th>
                    <th className="num">Sales</th>
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
                      <td className="num">{formatCount(row.count)}</td>
                      <td className="num">{formatRupiah(row.total)}</td>
                      <td className="num">{formatRupiah(row.dailyAverage)}</td>
                      <td className="num">{formatRupiah(row.channels.home.total)}</td>
                      <td className="num">{formatRupiah(row.channels.hotel.total)}</td>
                      <td className="num">{formatRupiah(row.channels.restaurant.total)}</td>
                      <td className="num">{formatRupiah(row.channels.depo.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card demand-section">
            <h2>Who bought in {monthName}</h2>
            <p className="hint">Sales in the latest month, from the customer name on the invoice.</p>
            <div className="demand-bars">
              {channelRows.map((row) => {
                const top = Math.max(1, ...channelRows.map((item) => item.value));
                return (
                  <div className="demand-bar-row" key={row.key}>
                    <span>{row.label}</span>
                    <span className="demand-bar-track" aria-hidden="true">
                      <span className="demand-bar-fill" style={{ width: row.value > 0 ? `${Math.max(4, Math.round((row.value / top) * 100))}%` : '0%' }} />
                    </span>
                    <strong>{formatRupiah(row.value)}</strong>
                  </div>
                );
              })}
            </div>
            <p className="hint">
              Still unpaid in {monthName}: {formatRupiah(month.open)}. Already paid: {formatRupiah(month.paid)}.
            </p>
          </section>

          <p className="hint">{data.season?.note}</p>
        </>
      )}
    </>
  );
}
