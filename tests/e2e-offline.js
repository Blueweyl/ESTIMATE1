const { chromium } = require('playwright');
const fs = require('fs');
const BASE = 'http://localhost:8787';
const NM = __dirname + '/node_modules/';
const CDN = {
  'https://unpkg.com/react@18.3.1/umd/react.production.min.js': NM + 'react/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js': NM + 'react-dom/umd/react-dom.production.min.js',
};
let failures = 0;
const check = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined && !cond ? '  -> ' + JSON.stringify(extra) : '')); if (!cond) failures++; };
const state = async () => (await fetch(BASE + '/__state')).json();
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await (process.env.CHROMIUM_PATH ? chromium.launch({ executablePath: process.env.CHROMIUM_PATH }) : chromium.launch());
  const context = await browser.newContext();
  await context.route('https://unpkg.com/**', route => { const f = CDN[route.request().url()]; f ? route.fulfill({ body: fs.readFileSync(f), contentType: 'text/javascript' }) : route.abort(); });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('dialog', d => d.accept());
  const nav = async l => page.getByText(l, { exact: true }).first().click();
  const field = l => page.locator(`div:has(> label:text-is("${l}")) > input`).first();

  // Legacy config: token stored in plaintext localStorage by the old version.
  await page.goto(BASE + '/');
  await page.evaluate(b => localStorage.setItem('qb_backend', JSON.stringify({ scriptUrl: b + '/exec', apiToken: 'test-token', connected: true })), BASE);
  await page.reload();
  await page.waitForSelector('text=Connected');
  const ls = await page.evaluate(() => localStorage.getItem('qb_backend'));
  check('legacy plaintext token moved out of localStorage, still connects', !ls.includes('test-token'), ls);

  // Seed one server project so we can delete it offline.
  await nav('Projects');
  await page.getByText('+ New Project', { exact: true }).click();
  await sleep(500);
  let st = await state();
  const seeded = st.Projects.rows[1][0];

  // Go offline: create + edit a project, delete the seeded one.
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await nav('Projects');
  await page.getByText('+ New Project', { exact: true }).click();
  await field('Wall Length (m)').fill('8'); await field('Wall Height (m)').fill('3');
  await page.getByText('Add to BOQ →').click();
  await sleep(1500);
  check('offline status shown', (await page.locator('div[title="Click to sync now"]').innerText()).includes('Offline'));
  await nav('Projects');
  await page.locator('tr', { hasText: 'Untitled Project' }).nth(1).locator('text=Delete').click();
  await sleep(300);
  check('offline delete queued', (await page.evaluate(() => localStorage.getItem('qb_pending_deletes'))).includes(seeded));

  // Reload while the backend is still unreachable: the offline project and its edits survive.
  await context.setOffline(false);
  await page.route('**/exec**', r => r.abort());
  await page.reload();
  await page.waitForSelector('text=QuantaBuild');
  await nav('Bill of Quantities');
  check('offline edits survive a reload', await page.getByText('Remove', { exact: true }).count() === 1);

  // Back online: reconnect flushes the delete and creates + saves the offline project.
  await page.unroute('**/exec**');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  for (let i = 0; i < 50; i++) { st = await state(); if (st.Projects.rows.length >= 3 && st.BOQ.rows.length >= 2) break; await sleep(100); }
  await sleep(500);
  st = await state();
  const deleted = st.Projects.rows.find(r => r[0] === seeded);
  check('offline delete synced on reconnect', deleted && deleted[8] === true, deleted);
  const created = st.Projects.rows.find(r => r[0] !== seeded && r[0] !== 'ProjectID');
  check('offline-created project created on reconnect', !!created, st.Projects.rows);
  check('offline BOQ line saved on reconnect', st.BOQ.rows.length === 2 && created && st.BOQ.rows[1][1] === created[0], st.BOQ.rows);
  await nav('Projects');
  check('deleted project not shown after reconnect', await page.locator('tr', { hasText: 'Untitled Project' }).count() === 1);
  check('no runtime errors', errors.length === 0, errors);
  await browser.close();
  console.log(failures ? failures + ' FAILURE(S)' : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
