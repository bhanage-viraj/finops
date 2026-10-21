import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  cancelAssistantProposal, confirmAssistantProposal, sendAssistantMessage,
} from '../api/assistant.js';

let nextId = 1;

function bubble(role, text) {
  nextId += 1;
  return { id: nextId, role, text };
}

/** Fixed chat. Existing screens are unchanged. Writes wait for Confirm. */
export default function Assistant() {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [messages, setMessages] = useState([]);
  const [proposal, setProposal] = useState(null);
  const [statementChecked, setStatementChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const scroller = useRef(null);

  useEffect(() => {
    if (!open) return;
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [open, messages, proposal, busy]);

  async function onSend(event) {
    event.preventDefault();
    const message = text.trim();
    if (!message || busy) return;
    const history = messages.slice(-8).map((row) => ({ role: row.role, text: row.text }));
    setMessages((prev) => [...prev, bubble('user', message)]);
    setText('');
    setProposal(null);
    setStatementChecked(false);
    setBusy(true);
    try {
      const body = await sendAssistantMessage({ message, history, path: location.pathname });
      setMessages((prev) => [...prev, bubble('assistant', body.reply || 'Done.')]);
      setProposal(body.proposal || null);
    } catch (error) {
      setMessages((prev) => [...prev, bubble('assistant', error.message || 'That request failed.')]);
    } finally {
      setBusy(false);
    }
  }

  async function onConfirm() {
    if (!proposal || busy) return;
    setBusy(true);
    try {
      const body = await confirmAssistantProposal(proposal.id, { statementChecked });
      setMessages((prev) => [...prev, bubble('assistant', body.reply || 'Confirmed.')]);
      setProposal(null);
      setStatementChecked(false);
    } catch (error) {
      setMessages((prev) => [...prev, bubble('assistant', error.message || 'That confirmation failed.')]);
    } finally {
      setBusy(false);
    }
  }

  async function onCancel() {
    if (!proposal || busy) return;
    setBusy(true);
    try {
      const body = await cancelAssistantProposal(proposal.id);
      setMessages((prev) => [...prev, bubble('assistant', body.reply || 'Cancelled.')]);
      setProposal(null);
      setStatementChecked(false);
    } catch (error) {
      setMessages((prev) => [...prev, bubble('assistant', error.message || 'Could not cancel.')]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {open && (
        <section className="assistant-panel" aria-label="Assistant">
          <div className="assistant-head">
            <strong>Assistant</strong>
            <span className="hint">Nothing is saved until you confirm.</span>
          </div>
          <div className="assistant-log" ref={scroller}>
            {messages.length === 0 && (
              <p className="hint">
                Write what you want done. Example: link AN Balinest this month to this transfer.
              </p>
            )}
            {messages.map((row) => (
              <p key={row.id} className={row.role === 'user' ? 'assistant-user' : 'assistant-bot'}>
                {row.text}
              </p>
            ))}
            {busy && <p className="hint">Checking…</p>}
          </div>
          {proposal && (
            <div className="assistant-proposal">
              <label className="assistant-check">
                <input
                  type="checkbox"
                  checked={statementChecked}
                  onChange={(event) => setStatementChecked(event.target.checked)}
                />
                <span>I checked this transfer on the bank statement.</span>
              </label>
              <div className="actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || (proposal.tool === 'record_payment' && !statementChecked)}
                  onClick={onConfirm}
                >
                  {busy ? 'Saving…' : 'Confirm'}
                </button>
                <button type="button" className="btn btn-secondary" disabled={busy} onClick={onCancel}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          <form className="assistant-form" onSubmit={onSend}>
            <input
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="What should I do?"
              aria-label="What should I do?"
              disabled={busy}
              autoComplete="off"
            />
            <button type="submit" className="btn btn-primary" disabled={busy || !text.trim()}>
              Send
            </button>
          </form>
        </section>
      )}
      <button
        type="button"
        className={open ? 'btn btn-secondary assistant-launch' : 'btn btn-primary assistant-launch'}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? 'Close' : 'Chat'}
      </button>
    </>
  );
}
