import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { fetchDocuments } from '../../api/documents.js';
import StatusBadge from '../../components/StatusBadge.jsx';
import UploadDropzone from '../../components/UploadDropzone.jsx';
import { formatRupiah } from '../../utils/formatRupiah.js';

const TYPES = [
  ['', 'All types'],
  ['fuel_receipt', 'Fuel receipt'],
  ['work_order', 'Work order'],
  ['supplier_receipt', 'Supplier receipt'],
  ['supplier_invoice', 'Supplier invoice'],
  ['purchase_order', 'Purchase order'],
  ['expense_receipt', 'Expense receipt'],
  ['other', 'Other'],
  ['unknown', 'Unknown'],
];

export default function DocumentQueue() {
  const [params, setParams] = useSearchParams();
  const [documents, setDocuments] = useState([]);
  const [error, setError] = useState('');

  const filters = {
    type: params.get('type') || '',
    status: params.get('status') || '',
    from: params.get('from') || '',
    to: params.get('to') || '',
    q: params.get('q') || '',
    needsReview: params.get('needsReview') || '',
  };

  function load() {
    fetchDocuments(filters).then((body) => setDocuments(body.documents)).catch((err) => setError(err.message));
  }

  useEffect(() => {
    load();
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, [params]);

  function setFilter(key, value) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key === 'status') next.delete('needsReview');
    setParams(next);
  }

  return (
    <>
      <h1>Documents</h1>
      <UploadDropzone
        onUploaded={load}
        title="Add receipt"
        hint="Fuel, supplier, work order, or other expense photo. Open a receipt to replace or delete it."
      />
      <div className="filters">
        <select aria-label="Document type" value={filters.type} onChange={(event) => setFilter('type', event.target.value)}>
          {TYPES.map(([value, label]) => <option key={value || 'all'} value={value}>{label}</option>)}
        </select>
        <select aria-label="Status" value={filters.needsReview ? 'review' : filters.status} onChange={(event) => {
          if (event.target.value === 'review') {
            const next = new URLSearchParams(params);
            next.delete('status');
            next.set('needsReview', '1');
            setParams(next);
          } else setFilter('status', event.target.value);
        }}>
          <option value="">All statuses</option>
          <option value="review">Needs review</option>
          <option value="processing">Processing</option>
          <option value="approved">Approved</option>
          <option value="failed">Failed</option>
          <option value="rejected">Rejected</option>
        </select>
        <input aria-label="From date" type="date" value={filters.from} onChange={(event) => setFilter('from', event.target.value)} />
        <input aria-label="To date" type="date" value={filters.to} onChange={(event) => setFilter('to', event.target.value)} />
        <input aria-label="Supplier or worker" placeholder="Supplier or worker" value={filters.q} onChange={(event) => setFilter('q', event.target.value)} />
      </div>
      {error && <p className="message message-bad">{error}</p>}
      {documents.length === 0 ? (
        <p className="card">No receipts in this view. Take a photo of one.</p>
      ) : (
        <>
        <div className="doc-cards">
          {documents.map((doc) => (
            <Link key={doc.id} to={`/documents/${doc.id}`} className="card doc-card">
              <div className="title-row">
                <strong>{doc.typeLabel}</strong>
                <StatusBadge status={doc.status} />
              </div>
              <p>{doc.searchParty || 'Party not read yet'}</p>
              <p className="subtext">{doc.searchDate || '—'} · {formatRupiah(doc.searchTotal)}</p>
            </Link>
          ))}
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Document</th>
                <th>Party</th>
                <th>Date</th>
                <th className="num">Total</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <tr key={doc.id}>
                  <td>
                    <Link to={`/documents/${doc.id}`}>{doc.typeLabel}</Link>
                    <div className="subtext">{doc.originalName}</div>
                  </td>
                  <td>{doc.searchParty || '—'}</td>
                  <td>{doc.searchDate || '—'}</td>
                  <td className="num">{formatRupiah(doc.searchTotal)}</td>
                  <td><StatusBadge status={doc.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}
    </>
  );
}
