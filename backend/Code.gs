/**
 * QuantaBuild — Google Apps Script backend
 * Google Sheets is the PRIMARY DATABASE (not a backup/export target).
 * See backend/DEPLOYMENT.md for deployment and backend/TEST_CHECKLIST.md for verification.
 */

const API_TOKEN_PROP = 'API_TOKEN';           // required shared secret, set in Script Properties
const ALLOWED_EMAILS_PROP = 'ALLOWED_EMAILS'; // optional: comma-separated list, enforced only if set
const LOCK_WAIT_MS = 10000;
const SNAPSHOT_CHUNK = 40000;                 // Sheets cells hold max 50,000 chars
const MAX_SNAPSHOT_CHARS = 2000000;
const MAX_TEXT = 500;                         // free-text field length limit
const REVISIONS_RETURNED = 30;

function getProp_(key) { return PropertiesService.getScriptProperties().getProperty(key); }

function authorize_(payload) {
  const expected = getProp_(API_TOKEN_PROP);
  if (!expected) throw new Error('Server not configured: missing API_TOKEN script property.');
  if (!payload || payload.token !== expected) throw new Error('Unauthorized: invalid or missing token.');

  const allowList = getProp_(ALLOWED_EMAILS_PROP);
  if (allowList) {
    // Only enforceable when deployed with "Execute as: User accessing the web app".
    const email = Session.getActiveUser().getEmail();
    const allowed = allowList.split(',').map(s => s.trim().toLowerCase());
    if (!email || allowed.indexOf(email.toLowerCase()) === -1) {
      throw new Error('Unauthorized: ' + (email || 'unknown user') + ' is not on the allow list.');
    }
  }
}

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

const SHEETS = {
  Projects:    ['ProjectID','ProjectName','Owner','Location','BuildingType','Status','Value','Version','IsDeleted','CreatedAt','UpdatedAt','CurrentRevisionID'],
  Estimates:   ['EstimateID','ProjectID','RevisionID','WorkType','Description','InputsJSON','QtyJSON','CreatedAt','CreatedBy'],
  Materials:   ['MaterialID','ProjectID','Name','Unit','Price','UpdatedAt'],
  LaborRates:  ['RateID','ProjectID','ScopeOfWork','Unit','LaborOnlyRate','SupplyInstallRate','UpdatedAt'],
  BOQ:         ['BOQItemID','ProjectID','RevisionID','Label','Qty','Unit','MaterialCost','LaborCost','Mode','LineTotal','SortOrder','UpdatedAt'],
  CostSummary: ['SummaryID','ProjectID','RevisionID','MaterialsSubtotal','LaborSubtotal','Equipment','Delivery','OverheadPct','ContingencyPct','ProfitPct','TaxEnabled','TaxPct','GrandTotal','CreatedAt'],
  Revisions:   ['RevisionID','ProjectID','RevisionNumber','Label','CreatedAt','CreatedBy','Notes','IsCurrent'],
  // Full client snapshot per revision, split into chunks so it fits Sheets' per-cell limit.
  // This is what makes restore_revision work: BOQ/Materials tabs only hold the CURRENT state.
  RevisionSnapshots: ['RevisionID','ProjectID','ChunkIndex','Data'],
  SyncLog:     ['LogID','ProjectID','Action','Status','Message','Timestamp','ClientID'],
};

// Globals reset on every execution, so this only skips repeat checks within one request.
let sheetsEnsured_ = false;

function ensureSheets_() {
  if (sheetsEnsured_) return;
  const sheet = ss_();
  Object.keys(SHEETS).forEach(name => {
    let sh = sheet.getSheetByName(name);
    if (!sh) { sh = sheet.insertSheet(name); sh.appendRow(SHEETS[name]); sh.setFrozenRows(1); return; }
    // Migrate older sheets missing new columns (e.g. Version, IsDeleted) without destroying data.
    const existingHeaders = sh.getRange(1,1,1,Math.max(sh.getLastColumn(),1)).getValues()[0];
    let nextCol = existingHeaders.filter(String).length + 1;
    SHEETS[name].forEach(col => {
      if (existingHeaders.indexOf(col) === -1) sh.getRange(1, nextCol++, 1, 1).setValue(col);
    });
  });
  sheetsEnsured_ = true;
}

// Run this once from the Apps Script editor (choose "setup" in the function menu, click Run).
// Functions ending in "_" are private and don't appear in that menu.
// Creates any missing tabs/columns and, if none exists yet, a random API token.
// Safe to re-run: never deletes data and never replaces an existing token.
function setup() {
  ensureSheets_();
  let token = getProp_(API_TOKEN_PROP);
  if (!token) {
    token = 'qb-' + Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 16);
    PropertiesService.getScriptProperties().setProperty(API_TOKEN_PROP, token);
    Logger.log('Created a new API token.');
  }
  Logger.log('QuantaBuild sheets are ready. Your API token (paste it into the app\'s Settings → API Token): ' + token);
}

function sheetByName_(name) { ensureSheets_(); return ss_().getSheetByName(name); }

function headersOf_(sh) { return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]; }

function rowsToObjects_(sh) {
  const values = sh.getDataRange().getValues();
  const headers = values.shift();
  return values.map((row, idx) => {
    const obj = { __row: idx + 2 };
    headers.forEach((h, i) => obj[h] = row[i]);
    return obj;
  });
}

function isDeleted_(r) { return r.IsDeleted === true || r.IsDeleted === 'TRUE' || r.IsDeleted === 'true'; }

function uid_(prefix) { return prefix + '_' + Utilities.getUuid().slice(0, 8); }
function nowIso_() { return new Date().toISOString(); }

// Formula-injection guard: a client string starting with = + - @ (or tab/CR) would be
// evaluated as a formula when written with setValues/appendRow. A leading apostrophe
// forces Sheets to store it as plain text (the apostrophe itself is not part of the value).
function safe_(v) {
  if (typeof v !== 'string') return v;
  return /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
}
function safeRow_(arr) { return arr.map(safe_); }
function text_(v) { return String(v == null ? '' : v).slice(0, MAX_TEXT); }

function logSync_(projectId, action, status, message, clientId) {
  try {
    sheetByName_('SyncLog').appendRow(safeRow_([uid_('log'), projectId || '', action, status, text_(message), nowIso_(), text_(clientId)]));
  } catch (e) { /* never let logging fail the main request */ }
}

/** HTTP entry points **/

// GET carries no token: anything in a query string ends up in browser history and
// Apps Script execution logs. Only the unauthenticated ping is served here.
function doGet(e) {
  const action = e.parameter.action;
  if (action === 'ping') return json_({ ok: true, time: nowIso_() });
  return json_({ ok: false, error: 'Unknown GET action: ' + action + '. Data actions are POST-only.' });
}

const READ_ACTIONS = { list_projects: 1, get_project: 1, health_check: 1, restore_revision: 1 };

function doPost(e) {
  let payload;
  try { payload = JSON.parse(e.postData.contents); }
  catch (err) { return json_({ ok: false, error: 'Invalid JSON body.' }); }

  try { authorize_(payload); }
  catch (err) { return json_({ ok: false, error: String(err) }); }

  const action = payload.action;

  // Reads don't need the write lock.
  if (READ_ACTIONS[action]) {
    try {
      if (action === 'list_projects') return json_(listProjects_(payload.includeDeleted === true));
      if (action === 'get_project') return json_(getProject_(payload.projectId));
      if (action === 'health_check') return json_(healthCheck_());
      if (action === 'restore_revision') return json_(restoreRevision_(payload));
    } catch (err) {
      return json_({ ok: false, error: String(err) });
    }
  }

  const lock = LockService.getScriptLock();
  let locked = false;
  try {
    locked = lock.tryLock(LOCK_WAIT_MS);
    if (!locked) return json_({ ok: false, error: 'Server busy, try again.' });
    let result;
    if (action === 'create_project') result = createProject_(payload);
    else if (action === 'update_project') result = updateProject_(payload);
    else if (action === 'delete_project') result = deleteProject_(payload);
    else if (action === 'restore_project') result = restoreProject_(payload);
    else if (action === 'migrate_push') result = migratePush_(payload);
    else if (action === 'log_sync') { logSync_(payload.projectId, payload.logAction, payload.status, payload.message, payload.clientId); result = { ok: true }; }
    else result = { ok: false, error: 'Unknown POST action: ' + action };
    return json_(result);
  } catch (err) {
    logSync_(payload.projectId, action, 'error', String(err), payload.clientId);
    return json_({ ok: false, error: String(err) });
  } finally {
    if (locked) lock.releaseLock();
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Validation **/

function nonNegative_(v, label) {
  const x = Number(v || 0);
  if (isNaN(x)) throw new Error(label + ' must be numeric');
  if (x < 0) throw new Error(label + ' cannot be negative');
}

function validateProjectPayload_(p) {
  if (!p) throw new Error('project payload required');
  if (!p.name || !String(p.name).trim()) throw new Error('project name is required');
  if (String(p.name).length > 200) throw new Error('project name is too long (max 200)');
  if (p.summary) {
    ['overheadPct','contingencyPct','profitPct','taxPct'].forEach(k => {
      const v = Number(p.summary[k] || 0);
      if (isNaN(v) || v < 0 || v > 100) throw new Error('summary.' + k + ' must be 0-100');
    });
    nonNegative_(p.summary.equipment, 'summary.equipment');
    nonNegative_(p.summary.delivery, 'summary.delivery');
  }
  (p.boq || []).forEach(b => {
    nonNegative_(b.materialCost, 'BOQ materialCost');
    nonNegative_(b.laborCost, 'BOQ laborCost');
  });
  (p.materials || []).forEach(m => nonNegative_(m.price, 'Material price (' + m.name + ')'));
  (p.laborRates || []).forEach(l => {
    nonNegative_(l.laborOnly, 'Labor-only rate (' + l.name + ')');
    nonNegative_(l.supplyInstall, 'Supply & install rate (' + l.name + ')');
  });
}

/** CRUD: Projects (list/get/create/update/delete/restore) **/

function listProjects_(includeDeleted) {
  const rows = rowsToObjects_(sheetByName_('Projects'));
  const filtered = includeDeleted ? rows : rows.filter(r => !isDeleted_(r));
  return { ok: true, projects: filtered };
}

function snapshotRevisionIds_() {
  const sh = sheetByName_('RevisionSnapshots');
  const last = sh.getLastRow();
  const ids = {};
  if (last > 1) sh.getRange(2, 1, last - 1, 1).getValues().forEach(r => { ids[r[0]] = true; });
  return ids;
}

function getProject_(projectId) {
  if (!projectId) return { ok: false, error: 'projectId required' };
  const project = rowsToObjects_(sheetByName_('Projects')).find(p => p.ProjectID === projectId);
  if (!project) return { ok: false, error: 'Project not found' };
  if (isDeleted_(project)) return { ok: false, error: 'Project has been deleted', deleted: true };
  const filterBy = rows => rows.filter(r => r.ProjectID === projectId);
  const withSnapshot = snapshotRevisionIds_();
  const revisions = filterBy(rowsToObjects_(sheetByName_('Revisions')))
    .sort((a, b) => Number(b.RevisionNumber || 0) - Number(a.RevisionNumber || 0))
    .slice(0, REVISIONS_RETURNED)
    .map(r => ({ ...r, hasSnapshot: !!withSnapshot[r.RevisionID] }));
  return {
    ok: true,
    project,
    materials: filterBy(rowsToObjects_(sheetByName_('Materials'))),
    laborRates: filterBy(rowsToObjects_(sheetByName_('LaborRates'))),
    boq: filterBy(rowsToObjects_(sheetByName_('BOQ'))).sort((a,b) => (a.SortOrder||0)-(b.SortOrder||0)),
    estimates: filterBy(rowsToObjects_(sheetByName_('Estimates'))),
    summary: filterBy(rowsToObjects_(sheetByName_('CostSummary'))).pop() || null,
    revisions,
  };
}

function createProject_(payload) {
  const { project, clientId } = payload;
  validateProjectPayload_(project);
  const sh = sheetByName_('Projects');
  // Idempotency: if client already created this project (retry after a dropped response), don't duplicate.
  if (project.clientGeneratedId) {
    const dupe = rowsToObjects_(sh).find(r => r.ProjectID === project.clientGeneratedId);
    if (dupe) return { ok: true, projectId: dupe.ProjectID, version: Number(dupe.Version || 1), alreadyExisted: true };
  }
  const projectId = project.clientGeneratedId || uid_('proj');
  const now = nowIso_();
  sh.appendRow(safeRow_([projectId, text_(project.name), text_(project.owner), text_(project.location), text_(project.type),
    text_(project.status || 'Draft'), Number(project.value) || 0, 1, false, now, now, '']));
  logSync_(projectId, 'create_project', 'ok', 'Created', clientId);
  return { ok: true, projectId, version: 1 };
}

// The core write path: full-snapshot save with optimistic concurrency.
// Client must send expectedVersion = the Version it last read. If the row's
// current Version has moved past that, we reject with conflict instead of overwriting.
function updateProject_(payload) {
  const { projectId, project, expectedVersion, clientId, revisionLabel, createIfMissing } = payload;
  if (!projectId) throw new Error('projectId required');
  validateProjectPayload_(project);

  const sh = sheetByName_('Projects');
  let existing = rowsToObjects_(sh).find(r => r.ProjectID === projectId);
  if (!existing && createIfMissing) {
    // Project was created while the client was offline; create it now with the client's ID.
    createProject_({ project: { ...project, clientGeneratedId: projectId }, clientId });
    existing = rowsToObjects_(sh).find(r => r.ProjectID === projectId);
  }
  if (!existing) throw new Error('Project not found: ' + projectId);
  if (isDeleted_(existing)) return { ok: false, error: 'Cannot update a deleted project. Restore it first.' };

  const serverVersion = Number(existing.Version || 1);
  if (expectedVersion !== undefined && Number(expectedVersion) < serverVersion) {
    return { ok: false, conflict: true, serverVersion, message: 'Project was updated elsewhere since you last loaded it. Reload to get the latest version.' };
  }

  const now = nowIso_();
  const newVersion = serverVersion + 1;
  const revisionId = uid_('rev');
  const revCountBefore = rowsToObjects_(sheetByName_('Revisions')).filter(r => r.ProjectID === projectId).length;
  const revNumber = revCountBefore + 1;
  const pick = (v, fallback) => v !== undefined && v !== null ? v : fallback;

  sh.getRange(existing.__row, 1, 1, SHEETS.Projects.length).setValues([safeRow_([
    projectId, text_(project.name), text_(pick(project.owner, existing.Owner)), text_(pick(project.location, existing.Location)),
    text_(pick(project.type, existing.BuildingType)), text_(project.status || existing.Status || 'Draft'),
    Number(project.value) || 0, newVersion, false, existing.CreatedAt, now, revisionId,
  ])]);

  replaceProjectRows_('Materials', projectId, (project.materials || []).map((m, i) => ({
    MaterialID: projectId + '_m' + i, ProjectID: projectId, Name: text_(m.name), Unit: text_(m.unit), Price: Number(m.price)||0, UpdatedAt: now,
  })));
  replaceProjectRows_('LaborRates', projectId, (project.laborRates || []).map((l, i) => ({
    RateID: projectId + '_l' + i, ProjectID: projectId, ScopeOfWork: text_(l.name), Unit: text_(l.unit),
    LaborOnlyRate: Number(l.laborOnly)||0, SupplyInstallRate: Number(l.supplyInstall)||0, UpdatedAt: now,
  })));
  // BOQ rows are stored individually (not just a JSON blob) so they're directly queryable/reportable in Sheets.
  replaceProjectRows_('BOQ', projectId, (project.boq || []).map((b, i) => ({
    BOQItemID: projectId + '_' + (b.id || ('b' + i)), ProjectID: projectId, RevisionID: revisionId, Label: text_(b.label), Qty: text_(b.qtyLabel), Unit: text_(b.unit),
    MaterialCost: Number(b.materialCost)||0, LaborCost: Number(b.laborCost)||0, Mode: text_(b.mode), LineTotal: (Number(b.materialCost)||0)+(Number(b.laborCost)||0),
    SortOrder: i, UpdatedAt: now,
  })));
  // Current calculator inputs, one row per work type (replaced, not appended, on each save).
  replaceProjectRows_('Estimates', projectId, (project.estimates || []).map(est => ({
    EstimateID: projectId + '_' + text_(est.workType), ProjectID: projectId, RevisionID: revisionId, WorkType: text_(est.workType),
    Description: text_(est.desc), InputsJSON: JSON.stringify(est.inputs || {}), QtyJSON: JSON.stringify(est.qty || {}), CreatedAt: now, CreatedBy: text_(clientId),
  })));
  if (project.summary) {
    upsertSingleRow_(sheetByName_('CostSummary'), 'ProjectID', projectId, {
      SummaryID: projectId + '_sum', ProjectID: projectId, RevisionID: revisionId,
      MaterialsSubtotal: Number(project.summary.materialsSubtotal)||0, LaborSubtotal: Number(project.summary.laborSubtotal)||0,
      Equipment: Number(project.summary.equipment)||0, Delivery: Number(project.summary.delivery)||0,
      OverheadPct: Number(project.summary.overheadPct)||0, ContingencyPct: Number(project.summary.contingencyPct)||0,
      ProfitPct: Number(project.summary.profitPct)||0, TaxEnabled: !!project.summary.taxEnabled, TaxPct: Number(project.summary.taxPct)||0,
      GrandTotal: Number(project.grandTotal)||0, CreatedAt: now,
    });
  }
  const label = text_(revisionLabel || ('Autosave ' + now));
  sheetByName_('Revisions').appendRow(safeRow_([revisionId, projectId, revNumber, label, now, text_(clientId), '', true]));
  const hasSnapshot = project.snapshot ? writeSnapshot_(revisionId, projectId, project.snapshot) : false;

  logSync_(projectId, 'update_project', 'ok', 'Saved v' + newVersion, clientId);
  return { ok: true, version: newVersion, revisionId, revisionNumber: revNumber, revisionLabel: label, hasSnapshot, savedAt: now };
}

function deleteProject_(payload) {
  const { projectId, clientId } = payload;
  const sh = sheetByName_('Projects');
  const existing = rowsToObjects_(sh).find(r => r.ProjectID === projectId);
  if (!existing) return { ok: false, error: 'Project not found' };
  sh.getRange(existing.__row, SHEETS.Projects.indexOf('IsDeleted') + 1).setValue(true);
  sh.getRange(existing.__row, SHEETS.Projects.indexOf('UpdatedAt') + 1).setValue(nowIso_());
  logSync_(projectId, 'delete_project', 'ok', 'Soft-deleted', clientId);
  return { ok: true };
}

function restoreProject_(payload) {
  const { projectId, clientId } = payload;
  const sh = sheetByName_('Projects');
  const existing = rowsToObjects_(sh).find(r => r.ProjectID === projectId);
  if (!existing) return { ok: false, error: 'Project not found' };
  sh.getRange(existing.__row, SHEETS.Projects.indexOf('IsDeleted') + 1).setValue(false);
  logSync_(projectId, 'restore_project', 'ok', 'Restored', clientId);
  return { ok: true };
}

// Replaces only this project's rows. Other projects' rows are never read in full or
// rewritten: we scan just the ProjectID column, append the new rows, then delete the
// old ones bottom-up in contiguous blocks (after the first save they are one block).
function replaceProjectRows_(sheetName, projectId, newRows) {
  const sh = sheetByName_(sheetName);
  const headers = headersOf_(sh);
  const colIdx = headers.indexOf('ProjectID');
  const lastRow = sh.getLastRow();
  const ids = lastRow > 1 ? sh.getRange(2, colIdx + 1, lastRow - 1, 1).getValues() : [];

  // Append first, so the delete below can never remove every non-frozen row.
  if (newRows.length) {
    sh.getRange(lastRow + 1, 1, newRows.length, headers.length)
      .setValues(newRows.map(obj => headers.map(h => safe_(obj[h] !== undefined ? obj[h] : ''))));
  }

  let i = ids.length - 1;
  while (i >= 0) {
    if (ids[i][0] !== projectId) { i--; continue; }
    const end = i;
    while (i - 1 >= 0 && ids[i - 1][0] === projectId) i--;
    if (sh.getMaxRows() <= sh.getLastRow()) sh.insertRowsAfter(sh.getMaxRows(), 1);
    sh.deleteRows(i + 2, end - i + 1);
    i--;
  }
}

function upsertSingleRow_(sh, idCol, id, obj) {
  const data = sh.getDataRange().getValues();
  const headers = data[0];
  const colIdx = headers.indexOf(idCol);
  const row = headers.map(h => safe_(obj[h] !== undefined ? obj[h] : ''));
  for (let i = 1; i < data.length; i++) {
    if (data[i][colIdx] === id) { sh.getRange(i+1, 1, 1, row.length).setValues([row]); return; }
  }
  sh.appendRow(row);
}

/** Revisions **/

// Each chunk is stored with a '~' prefix so a chunk that happens to start with
// '=' or '+' is never parsed as a formula. The prefix is stripped on read.
function writeSnapshot_(revisionId, projectId, snapshot) {
  const json = JSON.stringify(snapshot);
  if (json.length > MAX_SNAPSHOT_CHARS) throw new Error('Revision snapshot too large (' + json.length + ' chars)');
  const rows = [];
  for (let i = 0, n = 0; i < json.length; i += SNAPSHOT_CHUNK, n++) rows.push([revisionId, projectId, n, '~' + json.slice(i, i + SNAPSHOT_CHUNK)]);
  const sh = sheetByName_('RevisionSnapshots');
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, 4).setValues(rows);
  return true;
}

function readSnapshot_(projectId, revisionId) {
  const sh = sheetByName_('RevisionSnapshots');
  const last = sh.getLastRow();
  if (last < 2) return null;
  // Scan only the small key columns, then read just the matching Data cells.
  const keys = sh.getRange(2, 1, last - 1, 3).getValues();
  const chunks = [];
  keys.forEach((k, i) => { if (k[0] === revisionId && k[1] === projectId) chunks.push({ idx: Number(k[2]), row: i + 2 }); });
  if (!chunks.length) return null;
  chunks.sort((a, b) => a.idx - b.idx);
  return JSON.parse(chunks.map(c => String(sh.getRange(c.row, 4).getValue()).slice(1)).join(''));
}

// Read-only: returns the stored snapshot. The client applies it and its next autosave
// records the restored state as a NEW revision, so history is never rewritten.
function restoreRevision_(payload) {
  const { projectId, revisionId } = payload;
  if (!projectId || !revisionId) return { ok: false, error: 'projectId and revisionId required' };
  const rev = rowsToObjects_(sheetByName_('Revisions')).find(r => r.ProjectID === projectId && r.RevisionID === revisionId);
  if (!rev) return { ok: false, error: 'Revision not found' };
  const snapshot = readSnapshot_(projectId, revisionId);
  if (!snapshot) return { ok: false, error: 'This revision has no stored snapshot (it was saved before snapshots were added).' };
  return { ok: true, revisionId, label: rev.Label, snapshot };
}

/** Migration: push legacy localStorage snapshots the client had before this backend existed **/

function migratePush_(payload) {
  const { localProjects, clientId } = payload; // [{clientGeneratedId, project}]
  const results = [];
  (localProjects || []).forEach(entry => {
    try {
      const existing = rowsToObjects_(sheetByName_('Projects')).find(r => r.ProjectID === entry.clientGeneratedId);
      if (existing) { results.push({ clientGeneratedId: entry.clientGeneratedId, status: 'skipped-exists' }); return; }
      const created = createProject_({ project: { ...entry.project, clientGeneratedId: entry.clientGeneratedId }, clientId });
      if (created.ok) updateProject_({ projectId: created.projectId, project: entry.project, expectedVersion: 1, clientId, revisionLabel: 'Migrated from local storage' });
      results.push({ clientGeneratedId: entry.clientGeneratedId, status: 'migrated', projectId: created.projectId });
    } catch (err) {
      results.push({ clientGeneratedId: entry.clientGeneratedId, status: 'error', error: String(err) });
    }
  });
  logSync_('', 'migrate_push', 'ok', results.length + ' project(s) processed', clientId);
  return { ok: true, results };
}

/** Health check **/

function healthCheck_() {
  ensureSheets_();
  const counts = {};
  Object.keys(SHEETS).forEach(name => { counts[name] = sheetByName_(name).getLastRow() - 1; });
  const deleted = rowsToObjects_(sheetByName_('Projects')).filter(isDeleted_).length;
  return { ok: true, counts, deletedProjects: deleted, checkedAt: nowIso_() };
}
