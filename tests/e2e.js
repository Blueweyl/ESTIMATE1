const { chromium } = require('playwright');
const fs = require('fs');
const BASE = 'http://localhost:8787';
const NM = __dirname + '/node_modules/';
const CDN = {
  'https://unpkg.com/react@18.3.1/umd/react.production.min.js': NM + 'react/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js': NM + 'react-dom/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone@7.29.0/babel.min.js': NM + '@babel/standalone/babel.min.js',
};

let failures = 0;
const check = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined && !cond ? '  -> ' + JSON.stringify(extra) : '')); if (!cond) failures++; };
const state = async () => (await fetch(BASE + '/__state')).json();
const rowsFor = (st, sheet, pid) => { const [h, ...rows] = st[sheet].rows; const i = h.indexOf('ProjectID'); return rows.filter(r => r[i] === pid).map(r => Object.fromEntries(h.map((k, j) => [k, r[j]]))); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await (process.env.CHROMIUM_PATH ? chromium.launch({ executablePath: process.env.CHROMIUM_PATH }) : chromium.launch());
  const context = await browser.newContext();
  await context.route('https://unpkg.com/**', route => {
    const f = CDN[route.request().url()];
    if (f) route.fulfill({ body: fs.readFileSync(f), contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } });
    else route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const requests = [];
  page.on('request', r => { if (r.url().includes('/exec')) requests.push({ url: r.url(), method: r.method() }); });
  page.on('dialog', d => d.accept());

  const nav = async label => { await page.getByText(label, { exact: true }).first().click(); };
  const field = label => label.startsWith("Pakyaw Rate") ? page.locator(`div:has(> label:has-text("Pakyaw Rate")) > input`).first() : page.locator(`div:has(> label:text-is("${label}")) > input`).first();
  const fillField = async (label, v) => { await field(label).fill(String(v)); };
  const clickText = async t => { await page.getByText(t, { exact: true }).first().click(); };
  const waitSaved = async () => { await page.waitForFunction(() => /^Saved/.test(document.querySelector('div[title="Click to sync now"]').textContent.trim()), null, { timeout: 8000 }); };

  await page.goto(BASE + '/');
  await page.waitForSelector('text=QuantaBuild');
  check('page renders with no errors', errors.length === 0, errors);

  // Connect
  await nav('Settings');
  await page.locator('input[placeholder^="https://script.google.com"]').fill(BASE + '/exec');
  await page.locator('input[type="password"]').fill('wrong');
  await page.getByText('Connect', { exact: true }).click();
  await sleep(500);
  check('wrong token is rejected', await page.getByText('Not Connected').count() === 1);
  await page.locator('input[type="password"]').fill('test-token');
  await page.getByText('Connect', { exact: true }).click();
  await page.waitForSelector('text=Connected');
  await sleep(300);
  check('token never sent in a URL', requests.every(r => !r.url.includes('token')), requests);
  const ls = await page.evaluate(() => localStorage.getItem('qb_backend'));
  check('token not stored in localStorage by default', !ls.includes('test-token'), ls);
  check('empty server list replaces demo projects', await page.getByText('No project is open').count() === 1);

  // Project A
  await nav('Projects');
  await clickText('+ New Project');
  await sleep(400);
  let st = await state();
  const pidA = st.Projects.rows[1][0];
  check('new project row created in Sheets', st.Projects.rows.length === 2 && st.Projects.rows[1][7] === 1);

  await fillField('Wall Length (m)', 10);
  await fillField('Wall Height (m)', 3);
  await fillField('Block, ₱/pc', 20);
  await fillField('Pakyaw Rate (₱ / sqm)', 100);
  await page.getByText('Add to BOQ →').dblclick();
  await waitSaved();
  st = await state();
  const boqA = rowsFor(st, 'BOQ', pidA);
  check('double-click adds one BOQ line', boqA.length === 1, boqA.length);
  check('BOQ line has unit', boqA[0] && boqA[0].Unit === 'sqm', boqA[0]);
  check('calculator inputs persisted (Estimates)', rowsFor(st, 'Estimates', pidA).length === 6);
  check('revision snapshot stored', rowsFor(st, 'RevisionSnapshots', pidA).length >= 1);
  const projA = st.Projects.rows.find(r => r[0] === pidA);
  check('project value = grand total (not 0)', Number(projA[6]) > 0, projA);

  // Library price for A
  await nav('Cost Library');
  await page.locator('tr:has-text("Portland Cement") input').fill('300');
  await waitSaved();

  // Project B must not inherit A's data
  await nav('Projects');
  await clickText('+ New Project');
  await sleep(400);
  await nav('Cost Library');
  check('C2: new project has blank cement price', await page.locator('tr:has-text("Portland Cement") input').inputValue() === '');
  await nav('Estimator');
  check('C2: new project has blank calculator', await field('Wall Length (m)').inputValue() === '');
  st = await state();
  const pidB = st.Projects.rows.find(r => r[0] !== pidA && r[0] !== 'ProjectID')[0];
  await fillField('Wall Length (m)', 4); await fillField('Wall Height (m)', 2);
  await waitSaved();
  st = await state();
  check('A rows untouched after B saves', rowsFor(st, 'BOQ', pidA).length === 1 && rowsFor(st, 'Materials', pidA).find(m => m.Name.startsWith('Portland')).Price === 300);
  check('B has its own default-priced materials', rowsFor(st, 'Materials', pidB).every(m => m.Price === 0));

  // Switch back to A, then to B: each loads its own data
  await nav('Projects');
  await page.locator('tr', { hasText: 'Untitled Project' }).nth(1).click(); // list is newest first: B, A
  await page.waitForFunction(() => !document.body.innerText.includes('Loading project from Google Sheets'));
  await nav('Cost Library');
  check('C3: reopening A loads its cement price', await page.locator('tr:has-text("Portland Cement") input').inputValue() === '300');
  await nav('Bill of Quantities');
  check('reopening A loads its BOQ', await page.getByText('Remove', { exact: true }).count() === 1);
  await nav('Estimator');
  check('H2: reopening A restores calculator inputs', await field('Wall Length (m)').inputValue() === '10');

  // Revision restore (C4)
  await fillField('Wall Length (m)', 5);
  await page.getByText('Add to BOQ →').click();
  await waitSaved();
  await nav('Bill of Quantities');
  check('A now has 2 BOQ lines', await page.getByText('Remove', { exact: true }).count() === 2);
  // Reload A from the server so revisions come from Sheets (not local snapshots)
  await nav('Projects');
  await page.locator('tr', { hasText: 'Untitled Project' }).nth(0).click();
  await page.waitForFunction(() => !document.body.innerText.includes('Loading project'));
  await nav('Projects');
  await page.locator('tr', { hasText: 'Untitled Project' }).nth(1).click();
  await page.waitForFunction(() => !document.body.innerText.includes('Loading project'));
  await nav('Settings');
  const revCountBefore = rowsFor(await state(), 'Revisions', pidA).length;
  // Oldest restorable revision with 1 BOQ line: the one right after the first Add to BOQ.
  const restoreLinks = page.getByText('Restore', { exact: true });
  const n = await restoreLinks.count();
  check('server revisions listed as restorable', n >= 2, n);
  await restoreLinks.nth(n - 1).click(); // oldest = the save right after first Add to BOQ (1 line)
  for (let i = 0; i < 50 && rowsFor(await state(), 'Revisions', pidA).length === revCountBefore; i++) await sleep(100);
  await waitSaved();
  await nav('Bill of Quantities');
  check('C4: restoring server revision reverts BOQ', await page.getByText('Remove', { exact: true }).count() === 1);
  check('restore recorded as a new revision', rowsFor(await state(), 'Revisions', pidA).length === revCountBefore + 1);

  // H1: slow server, edits during an in-flight save must not self-conflict
  await fetch(BASE + '/__delay?ms=2500');
  await nav('Bill of Quantities');
  await page.locator('div:has(> label:text-is("Equipment, ₱")) > input').fill('100');
  await sleep(1500);
  await page.locator('div:has(> label:text-is("Delivery, ₱")) > input').fill('50');
  await sleep(1500);
  await page.locator('div:has(> label:text-is("Equipment, ₱")) > input').fill('150');
  await fetch(BASE + '/__delay?ms=0');
  await waitSaved();
  check('H1: no false conflict from overlapping saves', await page.getByText('Reload Latest Version').count() === 0);
  st = await state();
  check('H1: final values reached Sheets', rowsFor(st, 'CostSummary', pidA)[0].Equipment === 150 && rowsFor(st, 'CostSummary', pidA)[0].Delivery === 50, rowsFor(st, 'CostSummary', pidA)[0]);

  // Real conflict from another tab
  await fetch(BASE + '/__bump?id=' + pidA);
  await page.locator('div:has(> label:text-is("Delivery, ₱")) > input').fill('75');
  await page.waitForSelector('text=Reload Latest Version');
  check('external change -> conflict banner', true);
  st = await state();
  check('conflict did not overwrite Sheets', rowsFor(st, 'CostSummary', pidA)[0].Delivery === 50);
  await page.getByText('Reload Latest Version').click();
  await page.waitForFunction(() => !document.body.innerText.includes('Loading project'));
  check('reload clears conflict and shows server value', await page.locator('div:has(> label:text-is("Delivery, ₱")) > input').inputValue() === '50');

  // H4/H5 calculation checks (plaster, negative input)
  await nav('Estimator');
  await clickText('Plastering');
  await fillField('Wall Length (m)', -10);
  await fillField('Wall Height (m)', 2);
  check('H5: negative length clamps to zero', (await page.locator('text=Line Total').locator('..').innerText()).includes('₱0.00'));
  await fillField('Wall Length (m)', 10);
  await fillField('Wastage Allowance (%)', 10);
  await fillField('Pakyaw Rate (₱ / sqm)', 100);
  const laborTxt = await page.locator('text=Pakyaw Labor Cost').locator('..').innerText();
  check('H4: plaster labor on net area (20 sqm x 100 = 2,000)', laborTxt.includes('₱2,000.00'), laborTxt);

  // Formula injection via direct API call
  const resp = await (await fetch(BASE + '/exec', { method: 'POST', body: JSON.stringify({ action: 'create_project', token: 'test-token', project: { name: '=HYPERLINK("http://evil","x")', owner: '+cmd', clientGeneratedId: 'inj1' } }) })).json();
  st = await state();
  check('M2: formula-looking strings stored as text', resp.ok && Object.values(st).every(s => s.formulaWrites === 0) && st.Projects.rows.find(r => r[0] === 'inj1')[1].startsWith('=HYPERLINK'));

  // Reload: token survives in this tab (sessionStorage), project A reopens from Sheets
  await page.reload();
  await page.waitForSelector('text=QuantaBuild');
  await page.waitForFunction(() => document.body.innerText.includes('Loaded project from Google Sheets') || document.body.innerText.includes('Connected'), null, { timeout: 5000 }).catch(() => {});
  await sleep(800);
  await nav('Bill of Quantities');
  check('after reload, current project data is back', await page.getByText('Remove', { exact: true }).count() === 1);

  check('no runtime errors during run', errors.length === 0, errors);

  await browser.close();
  console.log(failures ? failures + ' FAILURE(S)' : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
