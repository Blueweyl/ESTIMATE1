# QuantaBuild — Google Sheets Database Deployment

Google Sheets is the **primary, authoritative database** — not a backup. Projects, BOQ line items, material prices, labor rates, cost summaries, and revision history all live in the spreadsheet; the browser only keeps a local cache for offline work and a queue of writes not yet confirmed by the server.

Architecture: `Estimator.dc.html` (frontend) → Apps Script Web App (`backend/Code.gs`, the only write path) → Google Sheet (database of record). `localStorage` is a cache, never the source of truth.

## 1. Create the spreadsheet
1. New Google Sheet, e.g. "QuantaBuild Database".
2. Extensions → Apps Script → replace the default code with `backend/Code.gs`.
3. Run `ensureSheets_` once from the editor to create all 9 tabs with headers (Projects, Estimates, Materials, LaborRates, BOQ, CostSummary, Revisions, RevisionSnapshots, SyncLog) and approve the permission prompts. Re-running this function later is always safe — it only adds missing columns, never deletes data (used for schema migrations, e.g. the `Version`/`IsDeleted` columns added for this upgrade).

## 2. Authorization (no publicly-writable endpoint)
1. Project Settings → Script Properties → add `API_TOKEN` = a long random secret. Every create/update/delete request is rejected without the exact matching token (`authorize_` in Code.gs) — treat it as a credential, not something pasted into chat or committed to a public repo.
2. Optional stronger control: add Script Property `ALLOWED_EMAILS` = comma-separated list of Workspace emails. This is only enforced when the Web App is deployed with **Execute as: User accessing the web app** (see below) — Apps Script then also knows the caller's signed-in Google identity, and `authorize_` rejects anyone not on the list even with a valid token.
3. Reads (`list_projects`, `get_project`, `health_check`, `restore_revision`) also require the token — nothing in the sheet is fetchable anonymously.
4. **The token only ever travels in a POST body.** GET serves `ping` alone; a query string would end up in browser history and Apps Script execution logs.
5. Know the ceiling: a static page plus a shared token cannot make the token secret from someone who can use the browser it's typed into. Treat this as an internal tool for a trusted team. For anything stronger, deploy as *User accessing the web app* with `ALLOWED_EMAILS` (so a leaked token alone is not enough) or put an authenticated proxy in front.

## 3. Deploy as Web App
1. Deploy → New deployment → **Web app**.
2. Execute as: **Me** (simplest; token is the only gate) — or **User accessing the web app** if you also set `ALLOWED_EMAILS` and will ask users to sign in. Who has access: restrict to your Workspace domain if available.
3. Deploy, authorize, copy the Web App URL (`…/exec`).
4. Every subsequent code change to Code.gs needs **Deploy → Manage deployments → Edit → New version** to take effect on the existing URL.

## 4. Connect the frontend
Use `QuantaBuild-Estimator.html`: a single file you can open directly or host anywhere. `Estimator.dc.html` needs `support.js` in the same folder and shows raw `{{ … }}` placeholders without it. After changing either source file, run `python3 build-standalone.py` to regenerate the single file.

Settings → Google Sheets Backup: paste the Web App URL and API token, click **Connect**. Connect calls `list_projects`, which verifies the token (a wrong token shows "Connection failed: Unauthorized"), then loads the authoritative project list, replacing the local demo rows.

The token input is masked. By default the token is kept in `sessionStorage` (this tab only) and you re-enter it in a new tab; turn on **Remember token on this device** to keep it in `localStorage` on a trusted computer. A token saved in plaintext by an older version is moved out of `localStorage` automatically.

## 5. Migrating existing local data
If you used an earlier version of this app (local-only or backup-style sync) before this database upgrade, open Settings → **Migrate Local Data** once after connecting. It reads every `qb_project_*` entry still in this browser's `localStorage`, pushes each as a new project via `migrate_push` (idempotent — re-running it skips projects that already exist on the server), and reports which were migrated vs. skipped vs. failed. Do this from the same browser/profile where the old data was created; `localStorage` is per-browser.

## Database schema

| Table | Role | Key columns |
|---|---|---|
| Projects | One row per project (source of truth for project list) | ProjectID, Version, IsDeleted, CurrentRevisionID |
| Estimates | Current calculator inputs, one row per work type (replaced on each save) | EstimateID, ProjectID, WorkType, InputsJSON |
| Materials | Centralized, per-project material price table | MaterialID, ProjectID, Name, Price |
| LaborRates | Centralized pakyaw labor rates (labor-only + supply-install) | RateID, ProjectID, LaborOnlyRate, SupplyInstallRate |
| BOQ | **Individual rows per line item** (not a JSON blob) — directly reportable in Sheets | BOQItemID, ProjectID, RevisionID, LineTotal, SortOrder |
| CostSummary | One row per revision: overhead/contingency/profit/tax/grand total | SummaryID, ProjectID, RevisionID, GrandTotal |
| Revisions | Append-only save history, never overwritten | RevisionID, RevisionNumber, IsCurrent |
| RevisionSnapshots | Full JSON snapshot of the project at each revision, chunked to fit the 50k-char cell limit — what `restore_revision` returns | RevisionID, ProjectID, ChunkIndex, Data |
| SyncLog | Every API call's outcome, for audit/debugging | LogID, Action, Status, Timestamp |

## CRUD API (all POST with `token` in the JSON body; only `ping` is GET)

| Action | Effect |
|---|---|
| `ping` (GET) | Liveness check, no token |
| `list_projects` | All non-deleted projects (`includeDeleted: true` for the trash) |
| `get_project` | Full bundle for one project: meta + materials + labor + BOQ + calculator inputs + summary + latest 30 revisions (each with `hasSnapshot`) |
| `create_project` | New project row, Version=1. Idempotent via `clientGeneratedId` — a retried create with the same ID won't duplicate |
| `update_project` | Full-snapshot save: replaces this project's Materials/LaborRates/BOQ/Estimates rows (other projects' rows are not touched), upserts its CostSummary, appends a Revision row plus its snapshot, bumps Version. Requires `expectedVersion`; rejected with `{conflict:true}` if the server has moved on. `revisionLabel` names the revision (used by "Save Revision"). `createIfMissing: true` creates the project first if it was made offline |
| `restore_revision` | Returns the stored snapshot for a revision. Read-only: the client applies it and its next save records the restore as a new revision |
| `delete_project` | Soft delete (`IsDeleted=true`) — recoverable, never erases rows |
| `restore_project` | Un-deletes |
| `migrate_push` | Bulk-imports local-only projects, skipping ones that already exist |
| `health_check` | Row counts per table + deleted-project count, for a quick DB sanity check |

## Concurrency & data-loss safeguards
- **Optimistic concurrency**: every `update_project` call carries `expectedVersion`. If another tab/user saved in between, the server refuses the write and returns the current `serverVersion` instead of silently overwriting — the frontend surfaces this as a **Conflict** state with a "Reload latest" action, never an automatic overwrite.
- **LockService**: all writes acquire a script-wide lock before touching any sheet, so two simultaneous saves can't interleave and corrupt a row.
- **Never marked saved until confirmed**: the UI only shows "Saved" after the server responds `ok:true` with a new version number — a dropped network request leaves the status as "Saving…" → "Sync Failed", not a false "Saved".
- **Soft delete**: `delete_project` only flips a flag; the row and all its BOQ/Materials/Revisions rows stay intact and are restorable.
- **Cross-project isolation**: every child table row is filtered and replaced strictly by `ProjectID` — a save to one project can never touch another's rows. In the browser, opening or creating a project starts from the defaults (or that project's own data), never from the previously open project.
- **One save in flight**: the client never sends a second `update_project` while one is pending (that would conflict with its own first save); later edits are queued and sent with the new version.
- **Validation**: negative prices, rates, costs and equipment/delivery amounts are rejected, percentages must be 0–100, and free-text fields are capped at 500 characters.
- **Formula injection**: every client string starting with `=`, `+`, `-` or `@` is written with a leading apostrophe, so Sheets stores it as text. The CSV export applies the same guard.
- **Offline**: edits, new projects and deletions made offline are kept in `localStorage` and synced on reconnect.

## Upgrading an existing deployment
Paste the new `Code.gs`, then **Deploy → Manage deployments → Edit → New version**. The `RevisionSnapshots` tab is created automatically on the next request (or run `ensureSheets_`). Revisions saved before this upgrade have no snapshot and show "No snapshot" instead of Restore. `create_revision` was removed; "Save Revision" now does a labelled `update_project`.

## Known limitations
Every autosave stores a full revision snapshot. For long-running projects the RevisionSnapshots tab grows steadily; archive or prune old rows if the spreadsheet gets large.

Design-preview sandboxes block cross-origin `fetch()` to your deployed script — expected there; works once hosted normally with your real URL and token. Apps Script Web Apps have per-execution quotas (6 min/execution, ~20,000 URL fetch calls/day on consumer accounts) — fine for a small team; for heavy concurrent multi-user load consider a dedicated database behind a real server instead of Sheets.
