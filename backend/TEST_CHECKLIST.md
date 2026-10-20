# Test Checklist — Google Sheets Database Integration

Run against a real deployed Web App (not the design-preview sandbox, which blocks cross-origin fetch).

Most of this list is also covered automatically by `tests/` (`cd tests && npm install && npm test`), which runs `Code.gs` in Node against a fake in-memory Sheet and drives the real page in headless Chromium. The fake doesn't model Apps Script quotas, real locking or network timing, so the manual pass on a real deployment is still needed.

## Connection & auth
- [ ] Settings → Connect with correct URL + token → badge turns "Connected", project list populates from `list_projects`.
- [ ] Wrong token → Connect fails with a visible error, no project data loads.
- [ ] Missing/placeholder URL → app stays in "Offline — working locally" status, no crash.
- [ ] `doPost` called without a token (e.g. via curl) → rejected with "Unauthorized"; `doGet` answers only `ping`.
- [ ] DevTools → Network: no request URL contains the token. Application → Local Storage → `qb_backend` has no token unless "Remember token" is on.

## Create / Read
- [ ] "+ New Project" while connected → new row appears in the Projects sheet with Version=1, IsDeleted=false.
- [ ] Reloading the page and reopening that project pulls the same data back (`get_project`), not stale local cache.
- [ ] Opening a project loads its BOQ rows, material prices, and labor rates exactly as last saved.

## Update / autosave
- [ ] Edit any input → status goes Saving… → Saved HH:MM within ~1.2s of the last keystroke.
- [ ] Check the sheet directly: BOQ tab rows for that project match the UI; a new Revisions row and CostSummary row were appended.
- [ ] Confirm "Saved" never shows before the network response returns (throttle network in devtools and watch it stay on "Saving…").

## Delete / restore
- [ ] Delete a project (with confirmation) → IsDeleted=true in the sheet; project disappears from the main list but data rows are untouched.
- [ ] Restore it → reappears with all BOQ/materials/revisions intact.

## Offline & reconnect
- [ ] Disconnect network (devtools offline) → edits still work, status shows "Offline — working locally", changes land in `localStorage`.
- [ ] Reconnect → pending changes sync automatically; SyncLog gets a new "ok" entry.
- [ ] Kill the network mid-save → status shows "Sync Failed"; manual "Sync Now" retries successfully once back online.

## Concurrency / multi-tab
- [ ] Open the same project in two tabs, edit in both → the second save should either succeed (if the first tab's change already landed and the second reloaded first) or return a conflict; verify the app shows a Conflict state rather than silently discarding one tab's edit.
- [ ] Trigger a conflict deliberately (edit tab A, save; then edit tab B using its stale `expectedVersion`, save) → tab B should receive `{conflict:true}` and NOT overwrite tab A's data in the sheet.

## Revisions
- [ ] "Save Revision" → new row in Revisions sheet with incrementing RevisionNumber.
- [ ] "Restore" an older revision → BOQ/cost summary in the UI reverts to that snapshot; saving afterward creates a new revision rather than mutating the old one.
- [ ] Reload the page, then restore a revision loaded from Sheets (not one made this session) → it reverts too.

## Migration
- [ ] With pre-existing `qb_project_*` keys in localStorage (from before backend was connected), run "Migrate Local Data" → each becomes a real Projects row; re-running the migration a second time reports "skipped-exists" for all of them (no duplicates).

## Data integrity
- [ ] Two different projects never share BOQ/Materials rows after saves (spot-check the sheet's ProjectID column).
- [ ] Set a price in Project A, click "+ New Project" → Cost Library and calculator are blank, not A's values.
- [ ] `health_check` action returns row counts matching what's visible in each sheet tab.
- [ ] Invalid payload (e.g. negative overhead %) is rejected server-side with a clear error, not silently clamped or saved.
