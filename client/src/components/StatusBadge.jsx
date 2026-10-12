const TONE = {
  approved: 'ok',
  confirmed: 'ok',
  matched: 'ok',
  needs_review: 'warn',
  submitted: 'warn',
  already_paid: 'warn',
  duplicate: 'warn',
  unmatched: 'neutral',
  processing: 'neutral',
  uploaded: 'neutral',
  failed: 'bad',
  rejected: 'bad',
};

const LABEL = {
  approved: 'Approved',
  confirmed: 'Paid',
  matched: 'Matched',
  needs_review: 'Needs review',
  submitted: 'Submitted',
  already_paid: 'Already paid',
  duplicate: 'Duplicate',
  unmatched: 'Unmatched',
  processing: 'Processing',
  uploaded: 'Awaiting',
  failed: 'Failed',
  rejected: 'Rejected',
};

export default function StatusBadge({ status }) {
  const tone = TONE[status] || 'neutral';
  return <span className={`badge badge-${tone}`}>{LABEL[status] || status}</span>;
}
