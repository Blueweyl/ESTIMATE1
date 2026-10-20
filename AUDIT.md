# QuantaBuild Audit — Estimator.dc.html + backend/Code.gs

Method: full static code review of the 4 files (line-by-line). Live Apps Script behavior (real Sheets writes, actual conflict timing, Apps Script quota limits) is **not independently tested** — no deployed backend exists to test against; those are flagged as "static-only, unverified live" below. UI/state-machine logic was verified by code-path tracing (no DOM test run performed this pass).

---

## CRITICAL

### C1 — API token is triple-exposed to anyone who opens the page
**File:** Estimator.dc.html, Settings screen input + `state.backend` + `testConnection()`/`refreshProjectList()`/`loadProject()`/`runHealthCheck()`
```html
<input placeholder="shared secret from Script Properties" value="{{ backend.apiToken }}" onChange="{{ h4.apiToken }}" style="{{ inputStyle }}"/>
```
```js
fetch(scriptUrl + '?action=list_projects&token=' + encodeURIComponent(apiToken))
try { localStorage.setItem('qb_backend', JSON.stringify(this.state.backend)); } catch(e) {}
```
- The token renders in a **plain visible text input** (not `type="password"`), is stored **unencrypted in localStorage**, and is sent as a **URL query parameter** on every GET (`list_projects`, `get_project`, `health_check`, trash fetch) — captured in Apps Script execution logs and browser history.
- **Repro:** open DevTools → Application → Local Storage → `qb_backend`; token is plaintext. Open Network tab → any GET request → token visible in the URL.
- **Business impact:** anyone with brief physical/screen access, a saved HAR file, or XSS can exfiltrate the one secret that gates all writes to the company's cost data.
- **Fix (architectural, not a one-line patch):** requirement #13 ("never assume a frontend token is secure") cannot be satisfied by a static HTML + shared-token design. Minimum mitigation: POST-only (never put token in a URL/query string), mask the input (`type="password"`), and treat this as a low-stakes internal tool only — true fix requires a thin authenticated proxy or Google Sign-In (`ALLOWED_EMAILS` path already stubbed in Code.gs) in front of the token.

### C2 — Creating a new project does not reset material prices, labor rates, cost-summary settings, or company info → cross-project contamination
**File:** Estimator.dc.html, `createNewProject()`
```js
createNewProject(){
  ...
  this.setState(s => ({ projects: [baseProject, ...s.projects], currentProjectId: localId, boq: [], revisions: [], projectVersion: 1, screen: 'estimator' }));
```
Only `boq`/`revisions`/`projectVersion` are reset. `libMaterials`, `libLabor`, `summary`, `company` are left untouched from whatever project was open before.
- **Repro:** Open Project A, set Cement price to ₱300. Click "+ New Project". Open Cost Library — Cement still shows ₱300, and it will be saved as Project B's price on first autosave.
- **Business impact:** silent price/rate leakage between unrelated projects — exactly the "cross-project contamination" the brief named as a critical requirement to prevent.
- **Fix:** reset `libMaterials`/`libLabor`/`summary` to their documented defaults (and clear `company` or make it a genuinely global, not per-project, setting) inside `createNewProject()`.

### C3 — Loading a project with zero saved materials/labor rows silently keeps the PREVIOUS project's data
**File:** Estimator.dc.html, `fromServerBundle()`
```js
libMaterials: materials.length ? materials.map(...) : this.state.libMaterials,
libLabor: laborRates.length ? laborRates.map(...) : this.state.libLabor,
```
If the newly-loaded project genuinely has no Materials/LaborRates rows yet (e.g. just created), the fallback keeps whatever was already in memory from the last project — not the schema defaults, not an empty table.
- **Repro:** Open Project A (has custom prices) → Open Project B (brand new, no rows in Sheets yet) → Cost Library still shows Project A's prices under Project B.
- **Fix:** fall back to the fixed default list (or an explicit empty state), never to `this.state.*` of the project being navigated away from.

### C4 — Revision "Restore" silently does nothing for every server-synced revision
**File:** Estimator.dc.html, `fromServerBundle()` + `restoreRevision()`
```js
revisions: (bundle.revisions||[]).map(r=>({ id:r.RevisionID, label:r.Label, timestamp:r.CreatedAt, snapshot:null })),
...
restoreRevision(rev){
  this.setState({ ...rev.snapshot });   // spreading null -> {} -> setState({}) -> no-op
  this.appendLog('Restored ' + rev.label, 'ok');
}
```
Revisions loaded from the backend are given `snapshot: null`. `restoreRevision` spreads that into `setState`, which is a no-op in JS — but the method still logs **"Restored Revision N — ok"**, telling the user a restore succeeded when nothing changed.
- Compounding: Code.gs's `restoreRevision_` endpoint (meant to fetch the actual historical BOQ/summary rows for a revision) is **never called from the frontend** — dead code server-side.
- **Repro:** Settings → any revision loaded from Sheets (not one created this session via "Save Revision") → click Restore → UI shows "Restored" in the log, BOQ/cost summary are unchanged.
- **Business impact:** "revision history, restore" (an explicit top-level requirement) does not work for the persisted case — only for same-tab-session, never-left-the-page revisions.
- **Fix:** `restoreRevision` must call the `restore_revision` POST action, apply the returned `boq`/`summary`/`estimates`, and only then confirm success — or disable/hide Restore for revisions with no local snapshot until that round-trip exists.

---

## HIGH

### H1 — Overlapping autosaves can produce a false "Conflict" against your own edits
**File:** Estimator.dc.html, `componentDidUpdate()` / `performSync()` / `syncNow()`; backend/Code.gs `updateProject_`
- The debounce timer is cleared/rescheduled correctly, but there is no "already in flight" guard around the `fetch` itself. If a save is slow (slow network) and the user edits again after the next 1.2s window elapses, a second `update_project` fires with the **same `expectedVersion`** (state hasn't been updated with the new version yet because the first response hasn't returned).
- Server-side: the second request's `expectedVersion` is now behind the version the first request just wrote, so `updateProject_` correctly returns `{conflict:true}` — but this is a **false positive**: it's the same user/tab, not an external edit, yet they'll see "Project changed elsewhere" and be told to reload (discarding their second edit's local-only state until they do).
- `syncNow()` also never clears/checks `this._syncTimer` or an in-flight flag, so a manual click can overlap with an auto-triggered save the same way.
- **Fix:** add an instance-level `this._syncInFlight` boolean; skip/queue new saves while true; have `syncNow()` cancel the pending debounce before firing.

### H2 — The six calculator forms (CHB/Rebar/Concrete/Plaster/Gypsum/Paint inputs) are never saved to or loaded from the backend
**File:** Estimator.dc.html, `toServerProject()` (sends `estimates: []` hardcoded), `fromServerBundle()` (never touches `chb`/`rebar`/etc. state)
- Only the *result* of "Add to BOQ" persists. A user who enters dimensions but hasn't clicked "Add to BOQ" yet loses that work on reload/project switch — contradicts requirement #4 ("new projects must create persistent records") and #3 ("opening a project must retrieve its saved data") read against the brief's explicit mention of "estimates" as a first-class saved entity.
- The `Estimates` sheet (designed in the schema specifically for this) is in practice **always empty** except for the one-time `migrate_push` path.
- **Fix:** either persist per-work-type form state into `project.estimates` on autosave and restore it in `fromServerBundle`, or explicitly document that only added BOQ lines are durable (and warn the user in-UI before navigating away from an un-added calculation).

### H3 — `replaceProjectRows_` rewrites the entire Materials/LaborRates/BOQ sheet (every project's rows) on every single autosave
**File:** backend/Code.gs
```js
function replaceProjectRows_(sheetName, projectId, newRows) {
  const data = sh.getDataRange().getValues();   // whole sheet, every project
  ...
  sh.clearContents();
  sh.appendRow(headers);
  if (keep.length) sh.getRange(2, 1, keep.length, headers.length).setValues(keep);
  ...
}
```
- Every autosave for Project A reads and rewrites ALL other projects' Materials/LaborRates/BOQ rows too, not just A's. Cost grows linearly with total rows across *every* project, not just the one being saved.
- Combined with the `LockService` (correct for safety) this means total system write throughput degrades as more projects/BOQ lines accumulate, and raises real risk of hitting Apps Script's 6-minute execution ceiling or rate limits under normal multi-project use — a reliability/performance risk, not just a performance nit.
- **Fix:** delete only the target project's existing rows (by scanning for matching row indices and using `deleteRows`, or marking+filtering) instead of clearing and rewriting the whole sheet; or move to one tab per entity keyed by row, updated via targeted `getRange` writes.

### H4 — Labor (pakyaw) cost is computed on wastage-inflated quantity for 4 of 6 work types, inconsistently
**File:** Estimator.dc.html, `computeCalc()`
- CHB: `laborCost = area*pakyawRate` — `area` excludes wastage. ✅ correct (labor shouldn't be paid extra for wasted material).
- Painting: `laborCost = area*pakyawRate` — `area` excludes wastage. ✅ correct.
- Rebar (kg mode): `laborCost = totalKg*pakyawRate` where `totalKg = totalLength*unitWeight*waste` — **wastage is baked into the labor basis.**
- Concrete: `laborCost = vol*pakyawRate` where `vol = L*W*T*waste` — **same issue.**
- Plaster: `laborCost = area*pakyawRate` where `area = L*H*sides*waste` — **same issue.**
- Gypsum: `laborCost = area*pakyawRate` where `area = f.area*waste` — **same issue.**
- **Business impact:** pakyaw labor is systematically overstated by the wastage % for rebar/concrete/plaster/gypsum lines, and the methodology is inconsistent across work types in the same BOQ — a real QS correctness issue a client or auditor would catch.
- **Fix:** compute labor cost from the un-wasted base quantity consistently (mirror the CHB/Paint pattern) across all six types; keep wastage applied only to material-quantity/cost.

### H5 — Negative-dimension guard (`Math.max(0, …)`) exists for CHB and Concrete but is missing for Plaster, Gypsum, Rebar
**File:** Estimator.dc.html, `computeCalc()`
```js
// CHB:      const area = Math.max(0, this.n(f.length)*this.n(f.height) - this.n(f.openingsArea));
// Concrete: const vol  = Math.max(0, this.n(f.length)*this.n(f.width)*this.n(f.thickness))*waste;
// Plaster:  const area = this.n(f.length)*this.n(f.height)*this.n(f.sides)*waste;        // no clamp
// Gypsum:   const area = this.n(f.area)*waste;                                            // no clamp
// Rebar:    const totalKg = this.n(f.totalLength)*unitWeight*waste;                       // no clamp
```
- **Repro:** Estimator → Plastering → enter Length = -10, Height = 2 → quantities and line cost go negative → "Add to BOQ" accepts a negative-cost line → Grand Total silently decreases.
- **Fix:** apply the same `Math.max(0, …)` clamp to Plaster/Gypsum/Rebar/Paint area/length/weight calculations.

### H6 — No keyboard/screen-reader accessibility anywhere in the app
**File:** Estimator.dc.html, throughout (nav items, work-type tabs, mode/thickness/class pills, toggles, Remove/Delete/Restore actions)
- Every interactive control is a `<div onClick>` with no `role="button"`, `tabIndex`, Enter/Space handling, or `aria-pressed`/`aria-selected` on toggle-style pills; `<label>` elements aren't associated to their inputs (no `htmlFor`/`id`).
- **Business impact:** the app is unusable by keyboard-only or screen-reader users; fails basic WCAG operability criteria.
- **Fix:** convert actionable `div`s to real `<button>`s (or add `role="button"` + `tabIndex="0"` + key handler), wire `<label for>`.

---

## MEDIUM

### M1 — CSV export is vulnerable to formula injection
**File:** Estimator.dc.html, `exportToExcel()`
```js
rows.push([r.label, r.qtyLabel, r.mode, r.materialCost.toFixed(2), r.laborCost.toFixed(2), ...]);
const csv = rows.map(r => r.map(c => '"' + String(c).replace(/"/g,'""') + '"').join(',')).join('\n');
```
A BOQ `label` beginning with `=`, `+`, `-`, or `@` is written verbatim into the CSV; Excel/Sheets will interpret it as a formula on open (classic CSV/"Formula Injection", CWE-1236).
- **Fix:** prefix any cell whose first character is `=`, `+`, `-`, `@`, or tab with a single quote `'` before quoting.

### M2 — Same formula-injection class exists server-side in every Sheets write
**File:** backend/Code.gs, `createProject_`, `updateProject_`, `replaceProjectRows_`, `upsertSingleRow_`
Client-supplied strings (project name, material/labor names, BOQ labels, company fields) are written straight into cells via `setValues`/`appendRow`. If a staff member later opens the spreadsheet directly, any cell starting with `=` executes as a formula.
- **Fix:** sanitize all free-text fields before writing (prefix a leading `'` when the first char is `=+-@`), applied once in a shared `sanitizeCell_()` helper used by every writer.

### M3 — Soft-deleting a project while offline is not durable
**File:** Estimator.dc.html, `deleteProject()`
```js
this.setState(s => ({ projects: s.projects.filter(p => p.id !== id) }));
if (connected) { ... } else { this.appendLog('Deleted locally — connect to Sheets to sync the deletion', 'warn'); }
```
The project is removed from in-memory state immediately regardless of connection state, but nothing is queued for later sync when offline — the "deletion" is never persisted or retried; a page refresh brings the project back (from the hardcoded demo seed or last server list), so the delete silently "un-happens."
- **Fix:** when offline, queue the delete intent (e.g. `localStorage` pending-deletes list) and flush it in the same reconnect handler that flushes pending saves.

### M4 — BOQ line items never carry a `unit`, so the sheet's `Unit` column is always blank
**File:** Estimator.dc.html, `addToBoq()` / `toServerProject()`; backend/Code.gs `updateProject_`
`addToBoq` stores `{id, workType, label, qtyLabel, materialCost, laborCost, mode}` — no `unit` field, even though `calc.unit` is computed and the BOQ sheet schema has a `Unit` column that Code.gs tries to read (`b.unit||''`).
- **Fix:** store `calc.unit` on the BOQ line at add-time and include it in `toServerProject()`'s boq mapping.

### M5 — No duplicate-click guard on "Add to BOQ"
**File:** Estimator.dc.html, `addToBoq()`
A fast double click (or double-tap) adds the same calculated line twice; nothing debounces the click or the handler.
- **Fix:** disable the button for ~300ms after click, or compare against the last-added signature before pushing.

### M6 — No visible loading/error state while a project is being fetched
**File:** Estimator.dc.html, `loadProject()`
The screen switches to "estimator" synchronously; if the `get_project` fetch is slow or fails, the user sees stale data with no spinner and only a Sync Log entry (easy to miss) indicating failure.
- **Fix:** add a `state.projectLoading` flag, show a skeleton/spinner on Estimator/BOQ/Library while true, and surface fetch failures as a dismissible banner, not just a log line.

### M7 — Two independent, non-interoperable "revisions" systems
**File:** Estimator.dc.html — `state.revisions` (client "Save Revision" button, holds a real local-only snapshot) vs. the server's auto-created Revisions row on every autosave (never fetched back except as a label-only, snapshot-less stub — see C4). These don't share IDs or semantics, so revision history as seen in Settings is incomplete and partially non-functional.
- **Fix:** unify around the server as the source of truth (see C4 fix) and drop or clearly relabel the client-only "Save Revision" as a lightweight bookmark distinct from the autosave history.

---

## LOW / Unverified risk (flagging, not confirmed exploitable in this review)

- **L1** Material/labor price inputs accept negative numbers client-side with no warning (server only validates summary percentages 0–100, not prices or dimensions) — plausible but not demonstrated to cause a wrong Grand Total beyond the Plaster case already confirmed in H5.
- **L2** `health_check`'s row counts (`getLastRow()-1`) will misreport if a sheet is ever manually edited to contain trailing blank formatted rows — cosmetic.
- **L3 (unverified, needs a real deployment)** Apps Script execution quotas (6 min/execution; ~20k URL Fetch calls/day on consumer accounts, lower throughput on cheaper tiers) — plausible bottleneck given H3, but actual quota impact can only be measured against a live deployment, not from code alone.
- **L4 (unverified)** Multi-tab same-project editing: the optimistic-concurrency check should correctly reject the losing tab's save (confirmed by reading `updateProject_`), but this was not exercised against a live two-tab session — flagging the mechanism as "sound by inspection," not "proven by test."
- **L5** No `@media` responsive breakpoints; two-column grids (Estimator, BOQ, Reports, Settings) will feel cramped under ~900px width. The original brief specified "desktop-first," so this is a known limitation rather than a regression, but worth a decision if mobile access is ever expected.
- **L6** Company name/address/terms and other free-text fields have no length limit — could produce oversized Sheets cells/rows at the extreme; no evidence this has been hit.

---

## What was NOT independently tested
- No real Apps Script Web App was deployed during this audit; **all backend behavior is verified by static code reading only**. `backend/TEST_CHECKLIST.md`'s items (live conflict timing, actual offline/reconnect flush, real quota ceilings, genuine multi-tab races) require deploying Code.gs and exercising the checklist — that has not been done, and this audit does not claim those paths "pass."
- No automated test suite exists in the project to run (no `/tests` folder, no CI config) — "run available automated tests" turned up none to run; this was pure code audit.

---

## Scores

| Area | Score /100 | Why |
|---|---|---|
| UX | 58 | Functional core flows, but no loading/error states for async project ops, no accessibility, stale cross-project data on switch (C2/C3), confusing dual revision model (M7) |
| Security | 42 | Sound shared-secret + LockService + server validation skeleton, but the token is exposed three ways (C1) and formula injection is open both client (M1) and server (M2) side |
| Database reliability | 54 | Real schema, soft delete, and optimistic concurrency are correctly designed; but cross-project contamination (C2/C3), broken revision restore (C4), a self-conflict race (H1), and a sheet-wide rewrite on every save (H3) are serious, confirmed gaps |
| Calculation accuracy | 70 | Core formulas (CHB, rebar kg/m=d²/162, concrete, plaster, gypsum, paint) are sound and not fabricated-citation; but labor-on-wasted-quantity is inconsistent across 4/6 types (H4) and negative-input guards are inconsistent (H5) |
| **Overall readiness** | **48** | Weighted toward Database reliability + Security given this turn's stated goal was making Sheets the real database — the core data-integrity and secret-handling defects are blocking issues, not polish |

## Go / No-Go: **NO-GO for production.**
Safe to continue as an internal pilot with a small trusted team ONLY after C1–C4 and H1–H3 are fixed; H4/H5 should be fixed before any client-facing quotation is trusted; M1–M2 should be fixed before the spreadsheet or CSV export is shared outside the immediate team.

## Prioritized fix checklist
1. C2/C3 — reset and correctly default per-project state on create/switch (contamination)
2. C4 — wire `restore_revision` end-to-end, drop the fake "Restored" success log
3. C1 — stop sending the token via URL query strings; mask the input field; document the architectural ceiling on frontend-secret security
4. H1 — add an in-flight guard around `performSync`
5. H3 — stop rewriting whole sheets per save; scope writes to the target project's rows only
6. H4 — make labor-cost basis consistent (un-wasted quantity) across all 6 work types
7. H5 — add missing `Math.max(0, …)` clamps (Plaster, Gypsum, Rebar)
8. M1/M2 — sanitize leading `=+-@` in every cell written client- or server-side
9. H2 — decide and implement: persist per-work-type calculator state, or explicitly warn users it's session-only
10. H6, M3–M7 — accessibility pass, offline-delete durability, BOQ `unit` field, loading states, revision-model cleanup

No Fajardo coefficients were invented or cited anywhere in the reviewed code — defaults are generic, labeled editable, and not attributed to any specific published source, consistent with the standing instruction.
