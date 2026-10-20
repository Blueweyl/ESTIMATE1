/**
 * QuantaBuild — Google Apps Script backend
 * Google Sheets is the PRIMARY DATABASE (not a backup/export target).
 * See backend/DEPLOYMENT.md for deployment and backend/TEST_CHECKLIST.md for verification.
 */

const API_TOKEN_PROP = 'API_TOKEN';           // required shared secret, set in Script Properties
const ALLOWED_EMAILS_PROP = 'ALLOWED_EMAILS'; // optional: comma-separated list, enforced only if set
const LOCK_WAIT_MS = 10000;

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
  SyncLog:     ['LogID','ProjectID','Action','Status','Message','Timestamp','ClientID'],
};

function ensureSheets_() {
  const sheet = ss_();
  Object.keys(SHEETS).forEach(name => {
    let sh = sheet.getSheetByName(name);
    if (!sh) { sh = sheet.insertSheet(name); sh.appendRow(SHEETS[name]); sh.setFrozenRows(1); return; }
    // Migrate older sheets missing new columns (e.g. Version, IsDeleted) without destroying data.
    const existingHeaders = sh.getRange(1,1,1,Math.max(sh.getLastColumn(),1)).getValues()[0];
    SHEETS[name].forEach((col, i) => {
      if (existingHeaders.indexOf(col) === -1) sh.getRange(1, existingHeaders.length + 1 + i, 1, 1).setValue(col);
    });
  });
}

function sheetByName_(name) { ensureSheets_(); return ss_().getSheetByName(name); }

function rowsToObjects_(sh) {
  const values = sh.getDataRange().getValues();
  const headers = values.shift();
  return values.map((row, idx) => {
    const obj = { __row: idx + 2 };
    headers.forEach((h, i) => obj[h] = row[i]);
    return obj;
  });
}

function uid_(prefix) { return prefix + '_' + Utilities.getUuid().slice(0, 8); }
function nowIso_() { return new Date().toISOString(); }

function logSync_(projectId, action, status, message, clientId) {
  try {
    sheetByName_('SyncLog').appendRow([uid_('log'), projectId || '', action, status, message || '', nowIso_(), clientId || '']);
  } catch (e) { /* never let logging fail the main request */ }
}

/** HTTP entry points **/

function doGet(e) {
  const action = e.parameter.action;
  try {
    if (action === 'ping') return json_({ ok: true, time: nowIso_() });
    // Read-only GETs still require a token to avoid exposing project data publicly.
    authorize_({ token: e.parameter.token });
    if (action === 'list_projects') return json_(listProjects_(e.parameter.includeDeleted === 'true'));
    if (action === 'get_project') return json_(getProject_(e.parameter.projectId));
    if (action === 'health_check') return json_(healthCheck_());
    return json_({ ok: false, error: 'Unknown GET action: ' + action });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  let payload;
  try { payload = JSON.parse(e.postData.contents); }
  catch (err) { return json_({ ok: false, error: 'Invalid JSON body.' }); }

  try { authorize_(payload); }
  catch (err) { return json_({ ok: false, error: String(err) }); }

  try {
    if (!lock.tryLock(LOCK_WAIT_MS)) return json_({ ok: false, error: 'Server busy, try again.' });
    const action = payload.action;
    let result;
    if (action === 'create_project') result = createProject_(payload);
    else if (action === 'update_project') result = updateProject_(payload);
    else if (action === 'delete_project') result = deleteProject_(payload);
    else if (action === 'restore_project') result = restoreProject_(payload);
    else if (action === 'create_revision') result = createRevision_(payload);
    else if (action === 'restore_revision') result = restoreRevision_(payload);
    else if (action === 'migrate_push') result = migratePush_(payload);
    else if (action === 'log_sync') { logSync_(payload.projectId, payload.logAction, payload.status, payload.message, payload.clientId); result = { ok: true }; }
    else result = { ok: false, error: 'Unknown POST action: ' + action };
    return json_(result);
  } catch (err) {
    logSync_(payload.projectId, payload.action, 'error', String(err), payload.clientId);
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Validation **/

function validateProjectPayload_(p) {
  if (!p) throw new Error('project payload required');
  if (!p.name || !String(p.name).trim()) throw new Error('project name is required');
  if (p.summary) {
    ['overheadPct','contingencyPct','profitPct','taxPct'].forEach(k => {
      const v = Number(p.summary[k] || 0);
      if (isNaN(v) || v < 0 || v > 100) throw new Error('summary.' + k + ' must be 0-100');
    });
  }
  (p.boq || []).forEach(b => {
    if (typeof b.materialCost !== 'number' && isNaN(Number(b.materialCost))) throw new Error('BOQ materialCost must be numeric');
    if (typeof b.laborCost !== 'number' && isNaN(Number(b.laborCost))) throw new Error('BOQ laborCost must be numeric');
  });
}

/** CRUD: Projects (list/get/create/update/delete/restore) **/

function listProjects_(includeDeleted) {
  const rows = rowsToObjects_(sheetByName_('Projects'));
  const filtered = includeDeleted ? rows : rows.filter(r => r.IsDeleted !== true && r.IsDeleted !== 'TRUE' && r.IsDeleted !== 'true');
  return { ok: true, projects: filtered };
}

function getProject_(projectId) {
  if (!projectId) return { ok: false, error: 'projectId required' };
  const project = rowsToObjects_(sheetByName_('Projects')).find(p => p.ProjectID === projectId);
  if (!project) return { ok: false, error: 'Project not found' };
  if (project.IsDeleted === true || project.IsDeleted === 'TRUE' || project.IsDeleted === 'true') {
    return { ok: false, error: 'Project has been deleted', deleted: true };
  }
  const filterBy = rows => rows.filter(r => r.ProjectID === projectId);
  return {
    ok: true,
    project,
    materials: filterBy(rowsToObjects_(sheetByName_('Materials'))),
    laborRates: filterBy(rowsToObjects_(sheetByName_('LaborRates'))),
    boq: filterBy(rowsToObjects_(sheetByName_('BOQ'))).sort((a,b) => (a.SortOrder||0)-(b.SortOrder||0)),
    summary: filterBy(rowsToObjects_(sheetByName_('CostSummary'))).pop() || null,
    revisions: filterBy(rowsToObjects_(sheetByName_('Revisions'))),
  };
}

function createProject_(payload) {
  const { project, clientId } = payload;
  validateProjectPayload_(project);
  const sh = sheetByName_('Projects');
  // Idempotency: if client already created this project (retry after a dropped response), don't duplicate.
  if (project.clientGeneratedId) {
    const dupe = rowsToObjects_(sh).find(r => r.ProjectID === project.clientGeneratedId);
    if (dupe) return { ok: true, projectId: dupe.ProjectID, version: dupe.Version, alreadyExisted: true };
  }
  const projectId = project.clientGeneratedId || uid_('proj');
  const now = nowIso_();
  sh.appendRow([projectId, project.name, project.owner||'', project.location||'', project.type||'', project.status||'Draft', project.value||0, 1, false, now, now, '']);
  logSync_(projectId, 'create_project', 'ok', 'Created', clientId);
  return { ok: true, projectId, version: 1 };
}

// The core write path: full-snapshot save with optimistic concurrency.
// Client must send expectedVersion = the Version it last read. If the row's
// current Version has moved past that, we reject with conflict instead of overwriting.
function updateProject_(payload) {
  const { projectId, project, expectedVersion, clientId, revisionLabel } = payload;
  if (!projectId) throw new Error('projectId required');
  validateProjectPayload_(project);

  const sh = sheetByName_('Projects');
  const rows = rowsToObjects_(sh);
  const existing = rows.find(r => r.ProjectID === projectId);
  if (!existing) throw new Error('Project not found: ' + projectId);
  if (existing.IsDeleted === true || existing.IsDeleted === 'TRUE' || existing.IsDeleted === 'true') {
    return { ok: false, error: 'Cannot update a deleted project. Restore it first.' };
  }

  const serverVersion = Number(existing.Version || 1);
  if (expectedVersion !== undefined && Number(expectedVersion) < serverVersion) {
    return { ok: false, conflict: true, serverVersion, message: 'Project was updated elsewhere since you last loaded it. Reload to get the latest version.' };
  }

  const now = nowIso_();
  const newVersion = serverVersion + 1;
  const revisionId = uid_('rev');
  const revCountBefore = rowsToObjects_(sheetByName_('Revisions')).filter(r => r.ProjectID === projectId).length;
  const revNumber = revCountBefore + 1;

  sh.getRange(existing.__row, 1, 1, SHEETS.Projects.length).setValues([[
    projectId, project.name, project.owner||'', project.location||'', project.type||'', project.status||existing.Status||'Draft',
    project.value||0, newVersion, false, existing.CreatedAt, now, revisionId,
  ]]);

  replaceProjectRows_('Materials', projectId, (project.materials || []).map(m => ({
    MaterialID: m.id || uid_('mat'), ProjectID: projectId, Name: m.name, Unit: m.unit, Price: Number(m.price)||0, UpdatedAt: now,
  })));
  replaceProjectRows_('LaborRates', projectId, (project.laborRates || []).map(l => ({
    RateID: l.id || uid_('rate'), ProjectID: projectId, ScopeOfWork: l.name, Unit: l.unit,
    LaborOnlyRate: Number(l.laborOnly)||0, SupplyInstallRate: Number(l.supplyInstall)||0, UpdatedAt: now,
  })));
  // BOQ rows are stored individually (not just a JSON blob) so they're directly queryable/reportable in Sheets.
  replaceProjectRows_('BOQ', projectId, (project.boq || []).map((b, i) => ({
    BOQItemID: b.id || uid_('boq'), ProjectID: projectId, RevisionID: revisionId, Label: b.label, Qty: b.qtyLabel, Unit: b.unit||'',
    MaterialCost: Number(b.materialCost)||0, LaborCost: Number(b.laborCost)||0, Mode: b.mode, LineTotal: (Number(b.materialCost)||0)+(Number(b.laborCost)||0),
    SortOrder: i, UpdatedAt: now,
  })));
  if (project.summary) {
    upsertSingleRow_(sheetByName_('CostSummary'), 'ProjectID', projectId, {
      SummaryID: uid_('sum'), ProjectID: projectId, RevisionID: revisionId,
      MaterialsSubtotal: project.summary.materialsSubtotal||0, LaborSubtotal: project.summary.laborSubtotal||0,
      Equipment: Number(project.summary.equipment)||0, Delivery: Number(project.summary.delivery)||0,
      OverheadPct: Number(project.summary.overheadPct)||0, ContingencyPct: Number(project.summary.contingencyPct)||0,
      ProfitPct: Number(project.summary.profitPct)||0, TaxEnabled: !!project.summary.taxEnabled, TaxPct: Number(project.summary.taxPct)||0,
      GrandTotal: project.grandTotal||0, CreatedAt: now,
    });
  }
  sheetByName_('Revisions').appendRow([revisionId, projectId, revNumber, revisionLabel || ('Autosave ' + now), now, clientId||'', '', true]);
  (project.estimates || []).forEach(est => {
    sheetByName_('Estimates').appendRow([uid_('est'), projectId, revisionId, est.workType, est.desc||'', JSON.stringify(est.inputs||{}), JSON.stringify(est.qty||{}), now, clientId||'']);
  });

  logSync_(projectId, 'update_project', 'ok', 'Saved v' + newVersion, clientId);
  return { ok: true, version: newVersion, revisionId, revisionNumber: revNumber, savedAt: now };
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

function replaceProjectRows_(sheetName, projectId, newRows) {
  const sh = sheetByName_(sheetName);
  const data = sh.getDataRange().getValues();
  const headers = data[0];
  const colIdx = headers.indexOf('ProjectID');
  const keep = data.slice(1).filter(r => r[colIdx] !== projectId);
  sh.clearContents();
  sh.appendRow(headers);
  if (keep.length) sh.getRange(2, 1, keep.length, headers.length).setValues(keep);
  if (newRows.length) sh.getRange(keep.length + 2, 1, newRows.length, headers.length)
    .setValues(newRows.map(obj => headers.map(h => obj[h] !== undefined ? obj[h] : '')));
}

function upsertSingleRow_(sh, idCol, id, obj) {
  const data = sh.getDataRange().getValues();
  const headers = data[0];
  const colIdx = headers.indexOf(idCol);
  const row = headers.map(h => obj[h] !== undefined ? obj[h] : '');
  for (let i = 1; i < data.length; i++) {
    if (data[i][colIdx] === id) { sh.getRange(i+1, 1, 1, row.length).setValues([row]); return; }
  }
  sh.appendRow(row);
}

/** Revisions **/

function createRevision_(payload) {
  const { projectId, label, clientId } = payload;
  const revisionId = uid_('rev');
  const sh = sheetByName_('Revisions');
  const count = rowsToObjects_(sh).filter(r => r.ProjectID === projectId).length;
  sh.appendRow([revisionId, projectId, count + 1, label || ('Revision ' + (count + 1)), nowIso_(), clientId || '', '', true]);
  return { ok: true, revisionId, revisionNumber: count + 1 };
}

function restoreRevision_(payload) {
  const { projectId, revisionId } = payload;
  const filterByRev = rows => rows.filter(r => r.ProjectID === projectId && r.RevisionID === revisionId);
  return {
    ok: true,
    boq: filterByRev(rowsToObjects_(sheetByName_('BOQ'))),
    summary: filterByRev(rowsToObjects_(sheetByName_('CostSummary'))).pop() || null,
    estimates: filterByRev(rowsToObjects_(sheetByName_('Estimates'))),
  };
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
  const deleted = rowsToObjects_(sheetByName_('Projects')).filter(r => r.IsDeleted === true || r.IsDeleted === 'TRUE').length;
  return { ok: true, counts, deletedProjects: deleted, checkedAt: nowIso_() };
}
