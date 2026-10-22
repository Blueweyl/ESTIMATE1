// The app served by Apps Script (HtmlService): google.script.run is emulated here by
// forwarding apiCall() to the fake backend's doPost.
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
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await (process.env.CHROMIUM_PATH ? chromium.launch({ executablePath: process.env.CHROMIUM_PATH }) : chromium.launch());
  const context = await browser.newContext();
  await context.route('https://unpkg.com/**', r => { const f = CDN[r.request().url()]; f ? r.fulfill({ body: fs.readFileSync(f), contentType: 'text/javascript' }) : r.abort(); });
  await context.addInitScript(() => {
    const runner = (ok, fail) => ({
      withSuccessHandler: h => runner(h, fail),
      withFailureHandler: h => runner(ok, h),
      apiCall: body => fetch('/exec', { method: 'POST', body }).then(r => r.text()).then(t => ok && ok(t), e => fail && fail(e)),
    });
    window.google = { script: { get run() { return runner(null, null); } } };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  if (process.env.DEBUG) page.on('console', m => console.log('console', m.text().slice(0, 200)));
  await page.goto(BASE + '/QuantaBuild-Estimator.html');
  await page.waitForSelector('text=Connected', { timeout: 5000 }).catch(() => {});
  await page.getByText('Settings', { exact: true }).first().click();
  check('auto-connects with no URL or token entered', await page.getByText('Connected', { exact: true }).count() >= 1);
  await page.getByText('Projects', { exact: true }).first().click();
  await page.getByText('+ New Project', { exact: true }).click();
  await page.locator('div:has(> label:text-is("Wall Length (m)")) > input').fill('10');
  await page.locator('div:has(> label:text-is("Wall Height (m)")) > input').fill('3');
  await page.getByText('Add to BOQ →').click();
  await page.waitForFunction(() => /^Saved/.test(document.querySelector('div[title="Click to sync now"]').textContent.trim()), null, { timeout: 8000 });
  const st = await (await fetch(BASE + '/__state')).json();
  check('saves through google.script.run', st.BOQ.rows.length === 2, st.BOQ.rows.length);
  check('no runtime errors', errors.length === 0, errors);
  await browser.close();
  console.log(failures ? failures + ' FAILURE(S)' : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
