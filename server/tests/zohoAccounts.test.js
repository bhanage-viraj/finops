import assert from 'node:assert/strict';
import test from 'node:test';
import { describeZohoPlan } from '../src/services/documents/zohoAccounts.js';
import { normalizeAccountRules } from '../src/services/admin/erpSettings.js';
import { rulesFromChart } from '../src/services/admin/zohoChart.js';

const rules = [
  { kind: 'expense', documentType: 'fuel_receipt', key: 'DK 8618 HJ', accountId: '111', label: 'DK 8618 HJ' },
  { kind: 'expense', documentType: 'fuel_receipt', key: 'DK 8094 HF', accountId: '112', label: 'PETROL DK 8094 HF' },
  { kind: 'expense', documentType: 'expense_receipt', key: 'Agus', accountId: '222', label: 'Freelance Agus' },
  { kind: 'paid_through', key: 'tunai', accountId: '333', label: 'Cash' },
  { kind: 'paid_through', key: 'default', accountId: '444', label: 'Bank' },
  { kind: 'paid_through', key: 'petty cash 2', accountId: '555', label: 'Petty Cash 2' },
  { kind: 'paid_through', key: 'petty cash ice', accountId: '556', label: 'Petty Cash Ice' },
];

function doc(type, fields, selectedAccountId = '', selectedPaidThroughAccountId = '') {
  return {
    documentType: type,
    confirmed: { fields },
    zohoExpense: { selectedAccountId, selectedPaidThroughAccountId },
  };
}

test('a petrol receipt uses the car number, including the Zoho account name', () => {
  const exact = describeZohoPlan(doc('fuel_receipt', {
    vehicle: { normalized: 'dk 8618 hj' },
    paymentMethod: { normalized: 'Tunai' },
  }), rules);
  assert.equal(exact.expenseAccountId, '111');
  assert.equal(exact.paidThroughAccountId, '555');
  const prefixed = describeZohoPlan(doc('fuel_receipt', {
    vehicle: { normalized: 'DK 8094 HF' },
  }), rules);
  assert.equal(prefixed.expenseAccountId, '112');
  assert.equal(prefixed.expenseLabel, 'PETROL DK 8094 HF');
  const otherCar = describeZohoPlan(doc('fuel_receipt', {
    vehicle: { normalized: 'DK 8621 QA' },
  }), rules);
  assert.equal(otherCar.ready, false);
  assert.match(otherCar.message, /DK 8621 QA/);
});

test('freelance work matches the person, and a chosen account overrides a missing name', () => {
  const named = describeZohoPlan(doc('expense_receipt', {
    supplier: { normalized: 'Agus' },
    paymentMethod: { normalized: '' },
  }), rules);
  assert.equal(named.expenseAccountId, '222');
  assert.equal(named.paidThroughAccountId, '555');
  const chosen = describeZohoPlan(doc('fuel_receipt', {
    vehicle: { normalized: 'ZZ 0000 ZZ' },
  }, '112'), rules);
  assert.equal(chosen.expenseAccountId, '112');
});

test('two petrol accounts that both match are not sent', () => {
  const plan = describeZohoPlan(doc('fuel_receipt', {
    vehicle: { normalized: 'DK 8618 HJ' },
  }), [
    ...rules,
    { kind: 'expense', documentType: 'fuel_receipt', key: 'DK8618HJ', accountId: '119', label: 'Duplicate' },
  ]);
  assert.equal(plan.ready, false);
  assert.match(plan.message, /More than one Zoho account/);
});

test('the chart maps petrol, service, and cash without using parent or asset accounts', () => {
  const chart = normalizeAccountRules(rulesFromChart([
    { account_id: '1', account_name: 'Petrol', account_type: 'expense', is_child_present: true },
    { account_id: '2', account_name: 'PETROL DK 8094 HF', account_type: 'expense', parent_account_name: 'Petrol' },
    { account_id: '3', account_name: 'SERVICE TRUCK DK 8094 HF', account_type: 'expense', parent_account_name: 'Repairs and Maintenance' },
    { account_id: '4', account_name: 'DK 8618 HJ', account_type: 'expense', parent_account_name: 'Petrol' },
    { account_id: '5', account_name: 'PETROL DK 8618 HJ', account_type: 'expense', parent_account_name: 'Petrol' },
    { account_id: '6', account_name: 'PETROL DK 8496 HI', account_type: 'expense', parent_account_name: 'Petrol' },
    { account_id: '7', account_name: 'PETROL DK 8496 HI NEW', account_type: 'expense', parent_account_name: 'Petrol' },
    { account_id: '8', account_name: 'PDAM', account_type: 'expense' },
    { account_id: '9', account_name: 'PLN', account_type: 'expense' },
    { account_id: '10', account_name: 'Petty Cash', account_type: 'cash' },
    { account_id: '11', account_name: 'Petty Cash Ice', account_type: 'cash' },
    { account_id: '12', account_name: 'MANDIRI BANK', account_type: 'bank' },
    { account_id: '15', account_name: 'Petty Cash 2', account_type: 'cash' },
    { account_id: '13', account_name: 'Land', account_type: 'fixed_asset' },
    { account_id: '14', account_name: 'Sales', account_type: 'income' },
  ]));
  assert.equal(chart.some((rule) => rule.label === 'Petrol' || rule.label === 'Land' || rule.label === 'Sales'), false);

  const fuel = describeZohoPlan(doc('fuel_receipt', {
    vehicle: { normalized: 'DK 8094 HF' },
    paymentMethod: { normalized: 'Mandiri' },
  }), chart);
  assert.equal(fuel.expenseAccountId, '2');
  assert.equal(fuel.paidThroughAccountId, '15');

  const exactPlate = describeZohoPlan(doc('fuel_receipt', {
    vehicle: { normalized: 'DK 8618 HJ' },
    paymentMethod: { normalized: 'Petty Cash' },
  }), chart);
  assert.equal(exactPlate.expenseAccountId, '4');
  assert.equal(exactPlate.paidThroughAccountId, '15');

  const twoPetrol = describeZohoPlan(doc('fuel_receipt', {
    vehicle: { normalized: 'DK 8496 HI' },
    paymentMethod: { normalized: 'Petty Cash' },
  }), chart);
  assert.equal(twoPetrol.ready, false);
  assert.match(twoPetrol.message, /More than one Zoho account/);

  const service = describeZohoPlan(doc('expense_receipt', {
    supplier: { normalized: 'Bengkel Maju' },
    description: { normalized: 'SERVICE TRUCK DK 8094 HF' },
    paymentMethod: { normalized: 'Petty Cash Ice' },
  }), chart);
  assert.equal(service.expenseAccountId, '3');
  assert.equal(service.paidThroughAccountId, '15');

  const bill = describeZohoPlan(doc('supplier_invoice', {
    supplier: { normalized: 'PDAM' },
    paymentMethod: { normalized: 'Petty Cash' },
  }), chart);
  assert.equal(bill.expenseAccountId, '8');

  const utilities = describeZohoPlan(doc('expense_receipt', {
    supplier: { normalized: 'PLN' },
    paymentMethod: { normalized: 'cash' },
  }), chart);
  assert.equal(utilities.expenseAccountId, '9');
  assert.equal(utilities.paidThroughAccountId, '15');
  assert.equal(utilities.ready, true);
});

test('a general rental matches Rent Expense, and a truck rental stays on Truck Rental', () => {
  const rentRules = [
    { kind: 'expense', documentType: 'expense_receipt', key: 'Forklift Rental', accountId: '1', label: 'Forklift Rental' },
    { kind: 'expense', documentType: 'expense_receipt', key: 'Truck Rental', accountId: '2', label: 'Truck Rental' },
    { kind: 'expense', documentType: 'expense_receipt', key: 'Rent Expense', accountId: '3', label: 'Rent Expense' },
    { kind: 'expense', documentType: 'expense_receipt', key: 'Warehouse Rent', accountId: '4', label: 'Warehouse Rent' },
    { kind: 'paid_through', key: 'petty cash 2', accountId: '12', label: 'Petty Cash 2' },
  ];
  const rental = describeZohoPlan(doc('expense_receipt', {
    supplier: { normalized: 'SUMBER SARI RENTAL' },
    date: { normalized: '2026-09-17' },
    total: { normalized: 175000 },
  }), rentRules);
  assert.equal(rental.expenseAccountId, '3');
  assert.equal(rental.expenseLabel, 'Rent Expense');
  assert.equal(rental.paidThroughAccountId, '12');
  const truck = describeZohoPlan(doc('expense_receipt', {
    supplier: { normalized: 'Truck Rental Bali' },
  }), rentRules);
  assert.equal(truck.expenseAccountId, '2');
});

test('an ice truck is paid through Petty Cash Ice', () => {
  const cashRules = [
    { kind: 'expense', documentType: 'fuel_receipt', key: 'PETROL DK 8094 HF', accountId: '2', label: 'PETROL DK 8094 HF' },
    { kind: 'expense', documentType: 'fuel_receipt', key: 'PETROL ES TRUCK DK 8973 HI', accountId: '3', label: 'PETROL ES TRUCK DK 8973 HI' },
    { kind: 'expense', documentType: 'fuel_receipt', key: 'PETROL ES TRUCK DK 8858 HI', accountId: '4', label: 'PETROL ES TRUCK DK 8858 HI' },
    { kind: 'paid_through', key: 'petty cash', accountId: '10', label: 'Petty Cash' },
    { kind: 'paid_through', key: 'petty cash ice', accountId: '11', label: 'Petty Cash Ice' },
    { kind: 'paid_through', key: 'petty cash 2', accountId: '12', label: 'Petty Cash 2' },
    { kind: 'paid_through', key: 'mandiri bank', accountId: '13', label: 'MANDIRI BANK' },
  ];
  const ice = describeZohoPlan(doc('fuel_receipt', {
    vehicle: { normalized: 'DK 8973 HI' },
    paymentMethod: { normalized: 'tunai' },
  }), cashRules);
  assert.equal(ice.expenseAccountId, '3');
  assert.equal(ice.paidThroughAccountId, '11');
  assert.equal(ice.paidThroughLabel, 'Petty Cash Ice');
  const otherIce = describeZohoPlan(doc('fuel_receipt', {
    vehicle: { normalized: 'DK 8858 HI' },
  }), cashRules);
  assert.equal(otherIce.expenseAccountId, '4');
  assert.equal(otherIce.paidThroughAccountId, '11');
  const bank = describeZohoPlan(doc('fuel_receipt', {
    vehicle: { normalized: 'DK 8973 HI' },
    paymentMethod: { normalized: 'Mandiri' },
  }), cashRules);
  assert.equal(bank.paidThroughAccountId, '11');
  const chosen = describeZohoPlan(doc('fuel_receipt', {
    vehicle: { normalized: 'DK 8973 HI' },
    paymentMethod: { normalized: 'cash' },
  }, '', '10'), cashRules);
  assert.equal(chosen.paidThroughAccountId, '10');
});

test('a car number or the word freelancer is matched from any text on the receipt', () => {
  const rules = [
    { kind: 'expense', documentType: 'fuel_receipt', key: 'PETROL DK 8504 HI NEW', accountId: '2', label: 'PETROL DK 8504 HI NEW' },
    { kind: 'expense', documentType: 'expense_receipt', key: 'Freelance Worker', accountId: '20', label: 'Freelance Worker' },
    { kind: 'expense', documentType: 'expense_receipt', key: 'FREE LANCER ICE', accountId: '21', label: 'FREE LANCER ICE' },
    { kind: 'paid_through', key: 'petty cash', accountId: '10', label: 'Petty Cash' },
    { kind: 'paid_through', key: 'petty cash ice', accountId: '11', label: 'Petty Cash Ice' },
    { kind: 'paid_through', key: 'petty cash 2', accountId: '12', label: 'Petty Cash 2' },
  ];
  const plate = describeZohoPlan(doc('fuel_receipt', {
    notes: { normalized: 'Nopol DK8504HI' },
    paymentMethod: { normalized: 'Petty Cash' },
  }), rules);
  assert.equal(plate.expenseAccountId, '2');
  assert.equal(plate.paidThroughAccountId, '12');
  const worker = describeZohoPlan(doc('work_order', {
    notes: { normalized: 'freelancer helper' },
    paymentMethod: { normalized: 'Petty Cash 2' },
  }), rules);
  assert.equal(worker.expenseAccountId, '20');
  assert.equal(worker.paidThroughAccountId, '12');
  const ice = describeZohoPlan(doc('work_order', {
    description: { normalized: 'FREE LANCER ICE' },
    paymentMethod: { normalized: 'Mandiri' },
  }), rules);
  assert.equal(ice.expenseAccountId, '21');
  assert.equal(ice.paidThroughAccountId, '12');
});

test('freelancer work uses Freelance Worker and Petty Cash 2', () => {
  const freelanceRules = [
    { kind: 'expense', documentType: 'expense_receipt', key: 'Freelance Worker', accountId: '20', label: 'Freelance Worker' },
    { kind: 'expense', documentType: 'expense_receipt', key: 'FREE LANCER ICE', accountId: '21', label: 'FREE LANCER ICE' },
    { kind: 'paid_through', key: 'petty cash', accountId: '10', label: 'Petty Cash' },
    { kind: 'paid_through', key: 'petty cash 2', accountId: '12', label: 'Petty Cash 2' },
    { kind: 'paid_through', key: 'mandiri bank', accountId: '13', label: 'MANDIRI BANK' },
  ];
  const plan = describeZohoPlan(doc('work_order', {
    description: { normalized: 'FREELANCER ORDER FORM' },
    workerName: { normalized: 'Fahur Rohman' },
    paymentMethod: { normalized: 'Petty Cash 2' },
    workDate: { normalized: '2026-10-12' },
    agreedAmount: { normalized: 120000 },
  }), freelanceRules);
  assert.equal(plan.expenseAccountId, '20');
  assert.equal(plan.expenseLabel, 'Freelance Worker');
  assert.equal(plan.paidThroughAccountId, '12');
  assert.equal(plan.paidThroughLabel, 'Petty Cash 2');
  assert.equal(plan.ready, true);
});

test('a work order uses the same four fields, including the agreed amount', () => {
  const plan = describeZohoPlan(doc('work_order', {
    workerName: { normalized: 'Fahur Rohman' },
    description: { normalized: 'FREELANCER ORDER FORM' },
    workDate: { normalized: '2026-10-12' },
    agreedAmount: { normalized: 120000 },
  }, '222', '333'), rules);
  assert.equal(plan.expenseAccountId, '222');
  assert.equal(plan.paidThroughAccountId, '333');
  assert.equal(plan.date, '2026-10-12');
  assert.equal(plan.amount, 120000);
  assert.equal(plan.ready, true);
  assert.ok(plan.choices.some((choice) => choice.accountId === '222'));
});

test('an expense receipt draft keeps the supplier and the whole rupiah amount', async () => {
  const { buildExpensePayload } = await import('../src/services/documents/zohoExpense.js');
  const payload = buildExpensePayload({
    _id: 'doc-1',
    documentType: 'expense_receipt',
    confirmed: {
      fields: {
        total: { normalized: 50000 },
        date: { normalized: '2026-08-10' },
        supplier: { normalized: 'ECALANG' },
        documentNumber: { normalized: 'EC-1' },
      },
    },
  }, {
    ready: true,
    expenseAccountId: '8',
    paidThroughAccountId: '10',
  });
  assert.equal(payload.amount, 50000);
  assert.equal(payload.date, '2026-08-10');
  assert.equal(payload.accountId, '8');
  assert.equal(payload.paidThroughAccountId, '10');
  assert.equal(payload.description, 'ECALANG · Expense receipt');
  assert.equal(payload.referenceNumber, 'EC-1');
});

test('account rules keep one row per car number', () => {
  const saved = normalizeAccountRules([
    { kind: 'expense', documentType: 'fuel_receipt', key: ' DK 8618 HJ ', accountId: '8727421901', label: '  DK 8618 HJ  ' },
    { kind: 'paid_through', key: ' Tunai ', accountId: '8727421902', label: 'Cash' },
  ]);
  assert.equal(saved[0].documentType, 'fuel_receipt');
  assert.equal(saved[0].key, 'DK 8618 HJ');
  assert.equal(saved[0].accountId, '8727421901');
  assert.throws(
    () => normalizeAccountRules([
      { kind: 'expense', documentType: 'fuel_receipt', key: 'DK 8618 HJ', accountId: '1', label: '' },
      { kind: 'expense', documentType: 'fuel_receipt', key: 'dk8618hj', accountId: '2', label: '' },
    ]),
    /one expense account/,
  );
});
