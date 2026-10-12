# ERP integration

`zohoBooks.js` is the only file that calls Zoho. It can refresh an OAuth token and create one expense. It does not list, update, or delete anything, and it does not call invoices, bills, contacts, bank transactions, or organizations.

Other files must not be added here unless a later phase explicitly starts them.
