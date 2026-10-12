import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { uploadDocuments } from '../api/documents.js';
import { compressImage } from '../utils/compressImage.js';

export default function UploadDropzone({ onUploaded, upload = uploadDocuments }) {
  const navigate = useNavigate();
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const busyRef = useRef(false);
  const [stream, setStream] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [tone, setTone] = useState('');
  const [useFileCamera, setUseFileCamera] = useState(false);
  const canPreview = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);

  useEffect(() => {
    const video = videoRef.current;
    if (video && stream) video.srcObject = stream;
  }, [stream]);

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  function stopCamera() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setStream(null);
  }

  function show(text, nextTone = '') {
    setMessage(text);
    setTone(nextTone);
  }

  async function openCamera() {
    show('');
    try {
      const next = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' } },
      });
      streamRef.current = next;
      setStream(next);
    } catch {
      setUseFileCamera(true);
      show('Tap Take photo again to open the phone camera.', 'warn');
    }
  }

  async function send(fileList, goToDocument) {
    const files = [...(fileList || [])];
    if (files.length === 0 || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    show(files.length === 1 ? 'Saving the photo…' : 'Saving the files…');
    try {
      const prepared = [];
      for (const file of files) prepared.push(await compressImage(file));
      const result = await upload(prepared);
      const saved = result.documents || [];
      if (saved.length === 0) {
        const reason = result.rejected?.map((item) => item.error).join(' ');
        throw new Error(reason || 'The photo did not upload. Try again.');
      }
      stopCamera();
      onUploaded?.(result);
      if (goToDocument && saved.length === 1) {
        navigate(`/documents/${saved[0].id}`);
        return;
      }
      const rejected = result.rejected?.length || 0;
      show(rejected
        ? `${saved.length} saved. ${rejected} rejected: ${result.rejected.map((item) => item.error).join(' ')}`
        : `${saved.length} file${saved.length === 1 ? '' : 's'} saved. Reading started.`, rejected ? 'warn' : 'ok');
    } catch (error) {
      const reason = error.rejected?.map((item) => item.error).filter(Boolean).join(' ');
      show(reason || error.message || 'The photo did not upload. Try again.', 'bad');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function onPicked(event, goToDocument) {
    send(event.target.files, goToDocument);
    event.target.value = '';
  }

  async function shoot() {
    const video = videoRef.current;
    if (!video?.videoWidth || busy) {
      show('The camera is not ready yet.', 'warn');
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    if (!blob) {
      show('The photo could not be taken. Try again.', 'bad');
      return;
    }
    const file = new File([blob], `receipt-${Date.now()}.jpg`, { type: 'image/jpeg' });
    await send([file], true);
  }

  const fileCamera = !canPreview || useFileCamera;

  return (
    <>
      <section
        className="card capture-card"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          send(event.dataTransfer.files, event.dataTransfer.files.length === 1);
        }}
      >
        <h2>Receipt photo</h2>
        <p className="hint">Take the photo on this phone. It is saved and read here.</p>
        <div className="capture-actions">
          {fileCamera ? (
            <label className="btn btn-primary btn-camera">
              {busy ? 'Saving…' : 'Take photo'}
              <input
                type="file"
                accept="image/*"
                capture="environment"
                disabled={busy}
                onChange={(event) => onPicked(event, true)}
              />
            </label>
          ) : (
            <button type="button" className="btn btn-primary btn-camera" disabled={busy} onClick={openCamera}>
              {busy ? 'Saving…' : 'Take photo'}
            </button>
          )}
          <label className="btn btn-secondary btn-camera">
            Choose from gallery
            <input
              type="file"
              accept="image/*,application/pdf"
              multiple
              disabled={busy}
              onChange={(event) => onPicked(event, event.target.files?.length === 1)}
            />
          </label>
        </div>
        <p className="hint capture-desktop">Or drop a photo or PDF here.</p>
        {message && !stream && (
          <p className={tone ? `message message-${tone}` : 'hint'}>{message}</p>
        )}
      </section>
      {stream && (
        <div className="camera-sheet" role="dialog" aria-modal="true" aria-label="Take a receipt photo">
          <div className="camera-top">
            <button type="button" className="btn btn-secondary" onClick={stopCamera} disabled={busy}>Close</button>
          </div>
          <div className="camera-stage">
            <video ref={videoRef} autoPlay playsInline muted />
            <div className="camera-guide" />
          </div>
          <p className="camera-hint">Lay the receipt flat, in good light, and fit all of it in the frame.</p>
          {message && <p className="camera-hint">{message}</p>}
          <div className="camera-controls">
            <label className="btn btn-secondary">
              Gallery
              <input
                type="file"
                accept="image/*,application/pdf"
                disabled={busy}
                onChange={(event) => onPicked(event, true)}
              />
            </label>
            <button type="button" className="shutter" aria-label="Take photo" disabled={busy} onClick={shoot} />
            <span />
          </div>
        </div>
      )}
    </>
  );
}
