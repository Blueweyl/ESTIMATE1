# QuantaBuild — Google Sheets Database Deployment

Google Sheets is the **primary, authoritative database** — not a backup. Projects, BOQ line items, material prices, labor rates, cost summaries, and revision history all live in the spreadsheet; the browser only keeps a local cache for offline work and a queue of writes not yet confirmed by the server.

Architecture: `Estimator.dc.html` (frontend) → Apps Script Web App (`backend/Code.gs`, the only write path) → Google Sheet (database of record). `localStorage` is a cache, never the source of truth.

## 1. Create the spreadsheet
1. New Google Sheet, e.g. "QuantaBuild Database".
2. Extensions → Apps Script → replace the default code with `backend/Code.gs`.
3. Run `ensureSheets_` once from the editor to create all 8 tabs with headers (Projects, Estimates, Materials, LaborRates, BOQ, CostSummary, Revisions, SyncLog) and approve the permission prompts. Re-running this function later is always safe — it only adds missing columns, never deletes data (used for schema migrations, e.g. the `Version`/`IsDeleted` columns added for this upgrade).

## 2. Authorization (no publicly-writable endpoint)
1. Project Settings → Script Properties → add `API_TOKEN` = a long random secret. Every create/update/delete request is rejected without the exact matching token (`authorize_` in Code.gs) — treat it as a credential, not something pasted into chat or committed to a public repo.
2. Optional stronger control: add Script Property `ALLOWED_EMAILS` = comma-separated list of Workspace emails. This is only enforced when the Web App is deployed with **Execute as: User accessing the web app** (see below) — Apps Script then also knows the caller's signed-in Google identity, and `authorize_` rejects anyone not on the list even with a valid token.
3. Reads (`list_projects`, `get_project`, `health_check`) also require the token — nothing in the sheet is fetchable anonymously.

## 3. Deploy as Web App
1. Deploy → New deployment → **Web app**.
2. Execute as: **Me** (simplest; token is the only gate) — or **User accessing the web app** if you also set `ALLOWED_EMAILS` and will ask users to sign in. Who has access: restrict to your Workspace domain if available.
3. Deploy, authorize, copy the Web App URL (`…/exec`).
4. Every subsequent code change to Code.gs needs **Deploy → Manage deployments → Edit → New version** to take effect on the existing URL.

## 4. Connect the frontend
Settings → Google Sheets Backup: paste the Web App URL and API token, click **Connect**. On success the app immediately calls `list_projects` to load the authoritative project list, replacing the local demo rows.

## 5. Migrating existing local data
If you used an earlier version of this app (local-only or backup-style sync) before this database upgrade, open Settings → **Migrate Local Data** once after connecting. It reads every `qb_project_*` entry still in this browser's `localStorage`, pushes each as a new project via `migrate_push` (idempotent — re-running it skips projects that already exist on the server), and reports which were migrated vs. skipped vs. failed. Do this from the same browser/profile where the old data was created; `localStorage` is per-browser.

## Database schema

| Table | Role | Key columns |
|---|---|---|
| Projects | One row per project (source of truth for project list) | ProjectID, Version, IsDeleted, CurrentRevisionID |
| Estimates | One row per calculator entry, with raw inputs | EstimateID, ProjectID, RevisionID, InputsJSON |
| Materials | Centralized, per-project material price table | MaterialID, ProjectID, Name, Price |
| LaborRates | Centralized pakyaw labor rates (labor-only + supply-install) | RateID, ProjectID, LaborOnlyRate, SupplyInstallRate |
| BOQ | **Individual rows per line item** (not a JSON blob) — directly reportable in Sheets | BOQItemID, ProjectID, RevisionID, LineTotal, SortOrder |
| CostSummary | One row per revision: overhead/contingency/profit/tax/grand total | SummaryID, ProjectID, RevisionID, GrandTotal |
| Revisions | Append-only save history, never overwritten | RevisionID, RevisionNumber, IsCurrent |
| SyncLog | Every API call's outcome, for audit/debugging | LogID, Action, Status, Timestamp |

## CRUD API (all POST unless noted, all require `token` in the body)

| Action | Verb | Effect |
|---|---|---|
| `list_projects` | GET | All non-deleted projects (add `includeDeleted=true` for the trash) |
| `get_project` | GET | Full bundle for one project: meta + materials + labor + BOQ + summary + revisions |
| `create_project` | POST | New project row, Version=1. Idempotent via `clientGeneratedId` — a retried create with the same ID won't duplicate |
| `update_project` | POST | Full-snapshot save: replaces this project's Materials/LaborRates/BOQ rows, appends a CostSummary + Revision row, bumps Version. Requires `expectedVersion`; rejected with `{conflict:true}` if the server has moved on |
| `delete_project` | POST | Soft delete (`IsDeleted=true`) — recoverable, never erases rows |
| `restore_project` | POST | Un-deletes |
| `create_revision` / `restore_revision` | POST | Manual snapshot and recall |
| `migrate_push` | POST | Bulk-imports local-only projects, skipping ones that already exist |
| `health_check` | GET | Row counts per table + deleted-project count, for a quick DB sanity check |

## Concurrency & data-loss safeguards
- **Optimistic concurrency**: every `update_project` call carries `expectedVersion`. If another tab/user saved in between, the server refuses the write and returns the current `serverVersion` instead of silently overwriting — the frontend surfaces this as a **Conflict** state with a "Reload latest" action, never an automatic overwrite.
- **LockService**: all writes acquire a script-wide lock before touching any sheet, so two simultaneous saves can't interleave and corrupt a row.
- **Never marked saved until confirmed**: the UI only shows "Saved" after the server responds `ok:true` with a new version number — a dropped network request leaves the status as "Saving…" → "Sync Failed", not a false "Saved".
- **Soft delete**: `delete_project` only flips a flag; the row and all its BOQ/Materials/Revisions rows stay intact and are restorable.
- **Cross-project isolation**: every child table row is filtered and replaced strictly by `ProjectID` — a save to one project can never touch another's rows.

## Known limitations
Design-preview sandboxes block cross-origin `fetch()` to your deployed script — expected there; works once hosted normally with your real URL and token. Apps Script Web Apps have per-execution quotas (6 min/execution, ~20,000 URL fetch calls/day on consumer accounts) — fine for a small team; for heavy concurrent multi-user load consider a dedicated database behind a real server instead of Sheets.
