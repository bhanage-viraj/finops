import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  approveDocument, chooseZohoAccount, fetchDocument, fetchDocumentFile,
  retryDocument, saveDocument, sendZohoExpense, submitDocument, testZohoExpense,
} from '../../api/documents.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';
import { formatRupiah } from '../../utils/formatRupiah.js';

export default function DocumentReview() {
  const { id } = useParams();
  const { user } = useAuth();
  const [document, setDocument] = useState(null);
  const [fields, setFields] = useState({});
  const [lineItems, setLineItems] = useState([]);
  const [type, setType] = useState('unknown');
  const [fileUrl, setFileUrl] = useState('');
  const [mime, setMime] = useState('');
  const [zoom, setZoom] = useState(1);
  const [page, setPage] = useState(1);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(null);
  const reviewer = user?.role === 'accountant' || user?.role === 'admin';

  function apply(doc) {
    setDocument(doc);
    setType(doc.documentType);
    setFields(Object.fromEntries(doc.form.map((field) => [field.key, field.value || ''])));
    setLineItems(doc.lineItems || []);
  }

  useEffect(() => {
    let cancelled = false;
    let url = '';
    async function load() {
      const body = await fetchDocument(id);
      if (cancelled) return;
      apply(body.document);
      const file = await fetchDocumentFile(id);
      if (cancelled) return;
      url = URL.createObjectURL(file.blob);
      setFileUrl(url);
      setMime(file.mimeType);
    }
    load().catch((err) => setError(err.message));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [id]);

  useEffect(() => {
    if (!document || !['uploaded', 'processing'].includes(document.status)) return undefined;
    const timer = setInterval(() => {
      fetchDocument(id).then((body) => apply(body.document)).catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [id, document?.status]);

  const planDate = document?.zohoPlan?.date ? document.zohoPlan.date.split('-').reverse().join('/') : '';
  const planComplete = Boolean(document?.zohoPlan?.ready) && Boolean(planDate) && Number.isInteger(document?.zohoPlan?.amount);
  const locked = ['approved', 'rejected', 'processing'].includes(document?.status);
  const dateKey = document?.documentType === 'work_order' ? 'workDate' : 'date';
  const amountKey = document?.documentType === 'work_order' ? 'agreedAmount' : 'total';

  function payload() {
    return { documentType: type, fields, lineItems };
  }

  async function run(action, { quiet = false } = {}) {
    setError('');
    if (!quiet) setMessage('');
    try {
      const body = await action();
      apply(body.document);
      if (!quiet) setMessage('Saved.');
    } catch (err) {
      setError(err.message);
    }
  }

  async function chooseAccount(selection) {
    setError('');
    setMessage('');
    setDraft(null);
    try {
      const body = await chooseZohoAccount(id, selection);
      apply(body.document);
    } catch (err) {
      setError(err.message);
    }
  }

  async function testExpense() {
    setError('');
    setMessage('');
    try {
      const body = await testZohoExpense(id);
      setDraft(body.draft);
      setMessage('Test only. Nothing was sent to Zoho.');
    } catch (err) {
      setDraft(null);
      setError(err.message);
    }
  }

  async function sendExpense() {
    setError('');
    setMessage('');
    try {
      const body = await sendZohoExpense(id);
      apply(body.document);
      setMessage('Expense created in Zoho Books.');
    } catch (err) {
      setError(err.message);
    }
  }

  if (!document) return <p className="muted">{error || 'Loading the document…'}</p>;

  return (
    <>
      <p className="crumb"><Link to="/documents">Documents</Link></p>
      <div className="title-row">
        <h1>{document.typeLabel}</h1>
        <StatusBadge status={document.status} />
      </div>
      {document.failureMessage && <p className="message message-bad">{document.failureMessage}</p>}
      {error && <p className="message message-bad">{error}</p>}
      {message && <p className="message message-ok">{message}</p>}
      <div className="review-grid">
        <section className="card viewer">
          <div className="viewer-tools">
            <button type="button" className="btn btn-secondary" onClick={() => setZoom((value) => Math.max(1, value - 0.25))}>Smaller</button>
            <button type="button" className="btn btn-secondary" onClick={() => setZoom((value) => Math.min(3, value + 0.25))}>Larger</button>
            {mime.includes('pdf') && (
              <>
                <button type="button" className="btn btn-secondary" onClick={() => setPage((value) => Math.max(1, value - 1))}>Previous page</button>
                <span>Page {page}{document.pageCount ? ` of ${document.pageCount}` : ''}</span>
                <button type="button" className="btn btn-secondary" onClick={() => setPage((value) => value + 1)}>Next page</button>
              </>
            )}
          </div>
          <div className="viewer-scroll">
            <div className="viewer-stage" style={{ width: `${zoom * 100}%` }}>
              {!fileUrl && <p className="hint">Loading the file…</p>}
              {fileUrl && mime.includes('pdf') && <iframe title="Document" src={`${fileUrl}#page=${page}`} />}
              {fileUrl && !mime.includes('pdf') && <img src={fileUrl} alt="Uploaded document" />}
            </div>
          </div>
        </section>
        <section className="card">
            <>
              <label className="field">
                <span className="field-label required">Date*</span>
                <input
                  value={fields[dateKey] || ''}
                  disabled={locked}
                  onChange={(event) => setFields((current) => ({ ...current, [dateKey]: event.target.value }))}
                  onBlur={() => run(() => saveDocument(id, payload()), { quiet: true })}
                />
              </label>
              <label className="field">
                <span className="field-label required">Expense account*</span>
                <select value={document.zohoPlan?.expenseAccountId || ''} disabled={!reviewer} onChange={(event) => chooseAccount({ accountId: event.target.value })}>
                  <option value="">Select an account</option>
                  {(document.zohoPlan?.choices || []).map((choice) => (
                    <option key={`${choice.accountId}-${choice.key}`} value={choice.accountId}>
                      {(choice.label || choice.key)} · {choice.accountId}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field-label required">Amount*</span>
                <input
                  value={fields[amountKey] || ''}
                  disabled={locked}
                  onChange={(event) => setFields((current) => ({ ...current, [amountKey]: event.target.value }))}
                  onBlur={() => run(() => saveDocument(id, payload()), { quiet: true })}
                />
              </label>
              <label className="field">
                <span className="field-label required">Paid through*</span>
                <select value={document.zohoPlan?.paidThroughAccountId || ''} disabled={!reviewer} onChange={(event) => chooseAccount({ paidThroughAccountId: event.target.value })}>
                  <option value="">Select an account</option>
                  {(document.zohoPlan?.paidChoices || []).map((choice) => (
                    <option key={`${choice.accountId}-${choice.key}`} value={choice.accountId}>
                      {(choice.label || choice.key)} · {choice.accountId}
                    </option>
                  ))}
                </select>
              </label>
              {document.zohoExpense?.expenseId && (
                <p className="message message-ok">Zoho expense {document.zohoExpense.expenseId}</p>
              )}
              {document.zohoExpense?.lastError && <p className="message message-bad">{document.zohoExpense.lastError}</p>}
              {draft && (
                <p className="message message-ok">
                  Test only. Nothing was sent. Date {draft.date.split('-').reverse().join('/')}. Expense account {draft.expenseLabel} · {draft.accountId}. Amount {formatRupiah(draft.amount)}. Paid through {draft.paidThroughLabel} · {draft.paidThroughAccountId}.
                </p>
              )}
              <div className="actions">
                {!locked && reviewer && ['needs_review', 'submitted'].includes(document.status) && (
                  <button type="button" className="btn btn-primary" onClick={() => run(() => saveDocument(id, payload()).then(() => approveDocument(id)))}>Approve</button>
                )}
                {!locked && !reviewer && document.status === 'needs_review' && (
                  <button type="button" className="btn btn-primary" onClick={() => run(() => saveDocument(id, payload()).then(() => submitDocument(id)))}>Submit for approval</button>
                )}
                {reviewer && ['needs_review', 'submitted', 'approved'].includes(document.status) && !document.zohoExpense?.expenseId && (
                  <button type="button" className="btn btn-secondary" disabled={!planComplete} onClick={testExpense}>Test before sending</button>
                )}
                {reviewer && document.status === 'approved' && !document.zohoExpense?.expenseId && (
                  <button type="button" className="btn btn-primary" disabled={!planComplete} onClick={sendExpense}>Send expense to Zoho</button>
                )}
                {document.status === 'failed' && (
                  <button type="button" className="btn btn-primary" onClick={() => run(() => retryDocument(id))}>Retry reading</button>
                )}
              </div>
            </>
        </section>
      </div>
    </>
  );
}
