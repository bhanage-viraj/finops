import { useState } from 'react';
import { uploadDocuments } from '../api/documents.js';

export default function UploadDropzone({ onUploaded, upload = uploadDocuments, title = 'Upload documents', hint = 'Choose photos, scans or PDFs' }) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function send(fileList) {
    const files = [...fileList];
    if (files.length === 0) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await upload(files);
      const saved = (result.documents || result.payments || []).length;
      const rejected = result.rejected?.length || 0;
      setMessage(rejected
        ? `${saved} saved. ${rejected} rejected: ${result.rejected.map((item) => item.error).join(' ')}`
        : `${saved} file${saved === 1 ? '' : 's'} saved. Reading started.`);
      onUploaded?.(result);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>{title}</h2>
      <label className="dropzone">
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,application/pdf"
          multiple
          disabled={busy}
          onChange={(event) => {
            send(event.target.files);
            event.target.value = '';
          }}
        />
        <span>{busy ? 'Saving…' : hint}</span>
      </label>
      {message && <p className="hint">{message}</p>}
    </section>
  );
}
