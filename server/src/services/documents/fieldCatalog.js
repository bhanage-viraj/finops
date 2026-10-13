export const DOCUMENT_TYPES = [
  'fuel_receipt',
  'work_order',
  'supplier_receipt',
  'supplier_invoice',
  'purchase_order',
  'expense_receipt',
  'other',
  'unknown',
];

export const CLASSIFIER_TYPES = DOCUMENT_TYPES.filter((type) => type !== 'other');

export const TYPE_LABELS = {
  fuel_receipt: 'Fuel receipt',
  work_order: 'Work order',
  supplier_receipt: 'Supplier receipt',
  supplier_invoice: 'Supplier invoice',
  purchase_order: 'Purchase order',
  expense_receipt: 'Expense receipt',
  other: 'Other',
  unknown: 'Unknown',
};

const text = (key, label) => ({ key, label, kind: 'text' });
const money = (key, label) => ({ key, label, kind: 'money' });
const quantity = (key, label) => ({ key, label, kind: 'quantity' });
const date = (key, label) => ({ key, label, kind: 'date' });

const COMMON_TAIL = [
  money('subtotal', 'Subtotal'),
  money('discount', 'Discount'),
  money('tax', 'Tax'),
  text('paymentMethod', 'Payment method'),
  text('notes', 'Notes'),
];

export const FIELD_CATALOG = {
  fuel_receipt: [
    date('date', 'Date'),
    text('time', 'Time'),
    text('supplier', 'Station'),
    text('location', 'Location'),
    text('documentNumber', 'Receipt number'),
    text('fuelType', 'Fuel type'),
    quantity('quantity', 'Litres'),
    money('unitPrice', 'Price per litre'),
    money('total', 'Total'),
    text('paymentMethod', 'Payment method'),
    text('vehicle', 'Vehicle'),
    text('notes', 'Notes'),
  ],
  work_order: [
    date('workDate', 'Work date'),
    text('workerName', 'Worker'),
    text('workerRole', 'Role'),
    text('phone', 'Phone'),
    text('startTime', 'Start'),
    text('endTime', 'End'),
    text('workLocation', 'Location'),
    text('description', 'Work'),
    money('agreedAmount', 'Agreed amount'),
    text('approvalNote', 'Approval'),
    text('notes', 'Notes'),
  ],
  supplier_receipt: [
    date('date', 'Date'),
    text('supplier', 'Supplier'),
    text('location', 'Location'),
    text('documentNumber', 'Receipt number'),
    money('total', 'Total'),
    ...COMMON_TAIL,
  ],
  supplier_invoice: [
    date('date', 'Invoice date'),
    date('dueDate', 'Due date'),
    text('supplier', 'Supplier'),
    text('location', 'Location'),
    text('documentNumber', 'Invoice number'),
    text('paymentTerms', 'Payment terms'),
    money('total', 'Total'),
    ...COMMON_TAIL,
  ],
  purchase_order: [
    date('date', 'Order date'),
    text('supplier', 'Supplier'),
    text('documentNumber', 'PO number'),
    text('paymentTerms', 'Terms'),
    money('total', 'Order total'),
    text('notes', 'Notes'),
  ],
  expense_receipt: [
    date('date', 'Date'),
    text('supplier', 'Supplier'),
    text('documentNumber', 'Receipt number'),
    money('total', 'Total'),
    money('tax', 'Tax'),
    text('paymentMethod', 'Payment method'),
    text('description', 'Description'),
    text('notes', 'Notes'),
  ],
  other: [
    date('date', 'Date'),
    text('supplier', 'Party'),
    text('documentNumber', 'Number'),
    money('total', 'Total'),
    text('description', 'Description'),
    text('notes', 'Notes'),
  ],
  unknown: [
    date('date', 'Date'),
    text('supplier', 'Party'),
    money('total', 'Total'),
    text('notes', 'Notes'),
  ],
};

// Match the review screen: date and amount only. Zoho accounts are checked
// separately before Send, not before Approve.
export const REQUIRED_FIELDS = {
  fuel_receipt: ['date', 'total'],
  work_order: ['workDate', 'agreedAmount'],
  supplier_receipt: ['date', 'total'],
  supplier_invoice: ['date', 'total'],
  purchase_order: ['date', 'total'],
  expense_receipt: ['date', 'total'],
  other: ['date', 'total'],
  unknown: [],
};

export function fieldsFor(type) {
  return FIELD_CATALOG[type] || FIELD_CATALOG.unknown;
}
