import { REQUIRED_FIELDS } from './fieldCatalog.js';
import { expectedLineTotal } from './numbers.js';

function issue(level, field, code, message) {
  return { level, field, code, message };
}

function moneyValue(field) {
  return field?.normalized ?? null;
}

function textValue(field) {
  return field?.normalized || null;
}

export function validateDocument(confirmed, { duplicate = null } = {}) {
  const type = confirmed?.documentType || 'unknown';
  const fields = confirmed?.fields || {};
  const issues = [];

  if (type === 'unknown') {
    issues.push(issue('critical', 'documentType', 'unknown_type', 'Choose a document type before approval. An uncertain document is not forced into a category.'));
  }

  for (const key of REQUIRED_FIELDS[type] || []) {
    const value = fields[key];
    const present = value && (value.normalized != null && value.normalized !== '');
    if (!present) {
      issues.push(issue('critical', key, 'required', 'This field is required before approval.'));
    }
  }

  for (const [key, value] of Object.entries(fields)) {
    if (value?.rejectedAsPhone) {
      issues.push(issue('critical', key, 'phone_as_money', 'This looks like a phone number, so it was not saved as money.'));
    }
    if (value?.fractional) {
      issues.push(issue('warning', key, 'rounded_rupiah', 'The original amount had a fractional part. The stored value is integer rupiah and the original text is unchanged.'));
    }
  }

  if (type === 'work_order') {
    const phone = textValue(fields.phone);
    const amount = fields.agreedAmount;
    if (phone && amount?.original && amount.original.replace(/\D/g, '') === phone.replace(/\D/g, '')) {
      issues.push(issue('critical', 'agreedAmount', 'phone_as_money', 'The agreed amount matches the phone number. Confirm which one is the pay.'));
    }
  }

  const lineItems = confirmed?.lineItems || [];
  let lineSum = 0;
  let summed = false;
  lineItems.forEach((item, index) => {
    const expected = expectedLineTotal(item.quantity, item.unitPrice);
    const actual = moneyValue(item.lineTotal);
    if (expected == null || actual == null) return;
    const diff = Math.abs(expected - actual);
    const field = `lineItems.${index}.lineTotal`;
    if (diff === 0) {
      lineSum += actual;
      summed = true;
      return;
    }
    if (diff <= 2) {
      issues.push(issue('warning', field, 'rounding', `Line ${index + 1} is ${diff} rupiah away from quantity times price. The total was not changed.`));
    } else {
      // Warning only: the review screen edits the total for Zoho, not line math.
      issues.push(issue('warning', field, 'arithmetic', `Line ${index + 1} does not match quantity times price (expected ${expected}, document says ${actual}). Check the total before sending.`));
    }
    lineSum += actual;
    summed = true;
  });

  const subtotal = moneyValue(fields.subtotal);
  const discount = moneyValue(fields.discount) || 0;
  const tax = moneyValue(fields.tax) || 0;
  const total = moneyValue(fields.total);
  if (subtotal != null && total != null) {
    const expected = subtotal - discount + tax;
    const diff = Math.abs(expected - total);
    if (diff > 2) {
      issues.push(issue('warning', 'total', 'total_mismatch', `Subtotal, discount and tax do not reach the total (expected ${expected}, document says ${total}). Check the amount before sending.`));
    } else if (diff > 0) {
      issues.push(issue('warning', 'total', 'rounding', `The total is ${diff} rupiah away from subtotal, discount and tax. The total was not changed.`));
    }
  } else if (summed && total != null) {
    const diff = Math.abs(lineSum - total);
    if (diff > 2) {
      issues.push(issue('warning', 'total', 'lines_mismatch', `The line totals add up to ${lineSum}, and the document total is ${total}. Check the amount before sending.`));
    } else if (diff > 0) {
      issues.push(issue('warning', 'total', 'rounding', `The line totals are ${diff} rupiah away from the document total. The total was not changed.`));
    }
  }

  if (type === 'purchase_order') {
    issues.push(issue('warning', 'documentType', 'not_an_expense', 'A purchase order is not a completed expense. Approval keeps the record and does not create an expense.'));
  }
  if (type === 'work_order') {
    issues.push(issue('warning', 'documentType', 'not_a_supplier_expense', 'This is pay for work. Approval does not create a supplier expense.'));
  }

  if (duplicate) {
    issues.push(issue('warning', 'duplicate', 'possible_duplicate', duplicate.message));
  }

  return {
    issues,
    critical: issues.filter((item) => item.level === 'critical'),
    warnings: issues.filter((item) => item.level === 'warning'),
    canApprove: issues.every((item) => item.level !== 'critical'),
  };
}

export function duplicateWarning({ shaMatches = [], fieldMatches = [] }) {
  if (shaMatches.length > 0) {
    return {
      duplicateOf: shaMatches[0],
      message: 'Another document has the same file. This is a warning, not a rejection.',
    };
  }
  if (fieldMatches.length > 0) {
    return {
      duplicateOf: fieldMatches[0],
      message: 'Another document has the same party, date and amount. Check it before approving. This is a warning, not a rejection.',
    };
  }
  return null;
}
