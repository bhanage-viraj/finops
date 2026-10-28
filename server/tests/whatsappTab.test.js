import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WHATSAPP_TAB,
  clipboardPlan,
  createWhatsAppOpener,
  whatsappUrl,
} from '../../client/src/pages/followUp/whatsappTab.js';

function installWindow() {
  const opens = [];
  let current = null;
  function makeTab(url) {
    const location = {
      _href: url || 'about:blank',
      fail: false,
      get href() { return this._href; },
      set href(value) {
        if (this.fail) {
          const error = new Error('blocked');
          error.name = 'SecurityError';
          throw error;
        }
        this._href = value;
      },
    };
    const tab = {
      closed: false,
      location,
      focus() {},
      close() { this.closed = true; },
    };
    current = tab;
    return tab;
  }
  const fake = {
    opens,
    open(url, name, features) {
      opens.push({ url, name, features });
      return makeTab(url);
    },
    sever() {
      if (current) current.closed = true;
    },
    blockNextNavigation() {
      if (current) current.location.fail = true;
    },
    get tab() { return current; },
  };
  globalThis.window = fake;
  return fake;
}

test('whatsapp links point at WhatsApp Web', () => {
  assert.equal(
    whatsappUrl('0812-345', 'Hi'),
    'https://web.whatsapp.com/send?phone=0812345&text=Hi',
  );
  assert.equal(
    whatsappUrl('', 'Hi there'),
    'https://web.whatsapp.com/send?text=Hi%20there',
  );
});

test('the second share reuses the open WhatsApp tab', () => {
  const fake = installWindow();
  const opener = createWhatsAppOpener();
  const first = opener.open('628111', 'one');
  assert.equal(first.status, 'opened');
  assert.equal(first.first, true);
  fake.sever();
  const second = opener.open('628222', 'two');
  assert.equal(second.status, 'same');
  assert.equal(fake.opens.length, 1);
  assert.equal(fake.opens[0].name, WHATSAPP_TAB);
  assert.equal(fake.opens[0].features, undefined);
  assert.equal(clipboardPlan(second, '628222', 'two').kind, 'number');
  assert.equal(clipboardPlan(second, '628222', 'two').text, '628222');
});

test('a tab we still control is navigated instead of opened again', () => {
  const fake = installWindow();
  const opener = createWhatsAppOpener();
  opener.open('628111', 'one');
  const second = opener.open('628222', 'two');
  assert.equal(second.status, 'opened');
  assert.equal(second.first, false);
  assert.equal(fake.opens.length, 1);
  assert.match(fake.opens[0].url, /628111/);
  assert.match(fake.tab.location.href, /628222/);
});

test('a summary reserves one tab and a failed send closes that blank tab', () => {
  const fake = installWindow();
  const opener = createWhatsAppOpener();
  const begun = opener.begin();
  assert.equal(begun.mode, 'reserved');
  assert.equal(fake.opens.length, 1);
  assert.equal(fake.opens[0].url, '');
  opener.cancel(begun);
  assert.equal(begun.tab.closed, true);
  const opened = opener.open('628333', 'three');
  assert.equal(opened.status, 'opened');
  assert.equal(fake.opens.length, 2);
});

test('after WhatsApp is open, a summary does not open another tab', () => {
  const fake = installWindow();
  const opener = createWhatsAppOpener();
  opener.open('628111', 'one');
  fake.sever();
  const begun = opener.begin();
  assert.equal(begun.mode, 'existing');
  const done = opener.finish(begun, '628444', 'four');
  assert.equal(done.status, 'same');
  assert.equal(fake.opens.length, 1);
});

test('a reserved summary tab is filled in without a second window', () => {
  const fake = installWindow();
  const opener = createWhatsAppOpener();
  const begun = opener.begin();
  const done = opener.finish(begun, '628555', 'five');
  assert.equal(done.status, 'opened');
  assert.equal(done.first, true);
  assert.equal(fake.opens.length, 1);
  assert.match(begun.tab.location.href, /628555/);
});

test('navigation that WhatsApp blocks does not open a replacement tab', () => {
  const fake = installWindow();
  const opener = createWhatsAppOpener();
  opener.open('628111', 'one');
  fake.blockNextNavigation();
  const second = opener.open('628222', 'two');
  assert.equal(second.status, 'same');
  assert.equal(fake.opens.length, 1);
});
