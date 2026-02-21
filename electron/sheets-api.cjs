'use strict';

const { google } = require('googleapis');
const fs         = require('fs');

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHEET_MIME        = 'application/vnd.google-apps.spreadsheet';
const EXCEL_MIME        = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const EXCEL_MIME_LEGACY  = 'application/vnd.ms-excel'; // catches older .xls files too
const EXCEL_MIME_MACRO   = 'application/vnd.ms-excel.sheet.macroenabled.12'; // .xlsm
const SHEET_FILTER = `(mimeType='${SHEET_MIME}' or mimeType='${EXCEL_MIME}' or mimeType='${EXCEL_MIME_LEGACY}' or mimeType='${EXCEL_MIME_MACRO}')`;

// List all folders + spreadsheets (Google Sheets and .xlsx) inside a given folder.
// Uses corpora:'allDrives' so files created by ANY member of a shared drive
// are returned — corpora:'drive' silently drops non-owner files in subfolders.
async function listFolder(auth, folderId) {
  const drive = google.drive({ version: 'v3', auth });
  const res   = await drive.files.list({
    q: `'${folderId}' in parents and (mimeType='${FOLDER_MIME}' or ${SHEET_FILTER}) and trashed=false`,
    orderBy:  'folder,name',
    pageSize: 200,
    fields:   'files(id,name,mimeType,modifiedTime,webViewLink)',
    corpora:                   'allDrives',
    includeItemsFromAllDrives: true,
    supportsAllDrives:         true,
  });
  return res.data.files || [];
}

// Spreadsheets (Google Sheets + .xlsx) shared directly with the user.
async function listSharedWithMe(auth) {
  const drive = google.drive({ version: 'v3', auth });
  const res   = await drive.files.list({
    q: `sharedWithMe and ${SHEET_FILTER} and trashed=false`,
    orderBy:  'modifiedTime desc',
    pageSize: 200,
    fields:   'files(id,name,mimeType,modifiedTime,webViewLink)',
    includeItemsFromAllDrives: true,
    supportsAllDrives:         true,
  });
  return res.data.files || [];
}

// Return the list of Shared Drives the user is a member of.
async function listSharedDrives(auth) {
  const drive = google.drive({ version: 'v3', auth });
  const res   = await drive.drives.list({
    pageSize: 50,
    fields:   'drives(id,name)',
  });
  return res.data.drives || [];
}

// ── Column headers for each debate format ─────────────────────────────────────
const FORMAT_HEADERS = {
  Policy: ['1AC', 'CX', '2NC', 'CX', '1AR', '2NR', '2AR'],
  LD:     ['AC', 'CX', 'NC', 'CX', '1AR', 'NR', '2AR'],
  PF:     ['Pro Case', 'Con Case', 'Rebuttal', 'Summary', 'FF'],
};

// Create a new flow spreadsheet in the given Drive folder.
// Returns { id, name, webViewLink } for the new file.
async function createFlowSheet(auth, { name, folderId, format }) {
  const drive  = google.drive({ version: 'v3', auth });
  const sheets = google.sheets({ version: 'v4', auth });

  // 1. Create the spreadsheet file in the target folder
  const driveFile = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents:  [folderId],
    },
    supportsAllDrives: true,
    fields: 'id,name,webViewLink',
  });

  const spreadsheetId = driveFile.data.id;

  // 2. Get the default sheet ID so we can reference it in batchUpdate
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetId = spreadsheet.data.sheets[0].properties.sheetId;

  // 3. Resolve header columns for the chosen format (default to Policy)
  const headers = FORMAT_HEADERS[format] || FORMAT_HEADERS.Policy;

  // 4. Write header row
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'Sheet1!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [headers] },
  });

  // 5. Format header row: bold + frozen + column widths
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        // Bold header row
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: 'userEnteredFormat.textFormat.bold',
          },
        },
        // Freeze header row
        {
          updateSheetProperties: {
            properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
            fields: 'gridProperties.frozenRowCount',
          },
        },
        // Set each column to 160px wide
        {
          updateDimensionProperties: {
            range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: headers.length },
            properties: { pixelSize: 160 },
            fields: 'pixelSize',
          },
        },
      ],
    },
  });

  return {
    id:          spreadsheetId,
    name:        driveFile.data.name,
    webViewLink: driveFile.data.webViewLink,
  };
}

// Upload a local .xlsx file to Drive, converting it to a Google Sheet in-place.
// Used when a user template (or a format with a linked custom template) is selected.
async function createFlowFromTemplate(auth, { name, folderId, filePath }) {
  const drive = google.drive({ version: 'v3', auth });

  const driveFile = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.spreadsheet', // convert to Sheets on upload
      parents:  [folderId],
    },
    media: {
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body:     fs.createReadStream(filePath),
    },
    supportsAllDrives: true,
    fields: 'id,name,webViewLink',
  });

  return {
    id:          driveFile.data.id,
    name:        driveFile.data.name,
    webViewLink: driveFile.data.webViewLink,
  };
}

// Add a new tab (sheet) to an existing spreadsheet.
// If copyFirstSheet=true, duplicates the first (blank template) sheet instead of
// creating a plain sheet — this preserves the user's template formatting.
// Returns { tabName, sheetId }
async function addFlowTab(auth, { spreadsheetId, tabName, format, copyFirstSheet = false }) {
  const sheets = google.sheets({ version: 'v4', auth });

  // Helper: return true if a GaxiosError is a "sheet name already exists" 400.
  function isNameConflict(err) {
    return err.code === 400 && String(err.message).includes('already exists');
  }

  // 1. Fetch existing sheet metadata without a fields filter.
  //    Field-mask syntax can silently return empty/partial data in the Node.js
  //    client, which would hollow-out the dedup Set and let "already exists"
  //    errors through. Fetching without a filter is always reliable
  //    (includeGridData defaults to false, so no cell values are fetched).
  const meta         = await sheets.spreadsheets.get({ spreadsheetId });
  const existingSheets = meta.data.sheets || [];
  const existingTitles = new Set(existingSheets.map(s => s.properties.title));

  // 2. Resolve a unique name from existing sheet titles: Aff → Aff 2 → Aff 3 …
  const baseName = tabName;
  let counter    = 2;
  while (existingTitles.has(tabName)) {
    tabName = `${baseName} ${counter++}`;
  }

  let newSheetId;

  if (copyFirstSheet && existingSheets.length > 0) {
    // ── Template copy path ───────────────────────────────────────────────────
    // Duplicate the first sheet (the blank template) within this spreadsheet.
    // The copy inherits all cell formatting, column widths, frozen rows, etc.
    const sourceSheetId = existingSheets[0].properties.sheetId;

    const copyRes = await sheets.spreadsheets.sheets.copyTo({
      spreadsheetId,
      sheetId: sourceSheetId,
      requestBody: { destinationSpreadsheetId: spreadsheetId },
    });
    newSheetId = copyRes.data.sheetId;

    // Rename the copy (it lands as "Copy of <original name>").
    // The dedup above uses a point-in-time snapshot, so a conflict can still
    // occur if another tab was added concurrently or if a prior failed operation
    // left a stale sheet.  Retry with an incremented suffix until it lands.
    let renamed = false;
    while (!renamed) {
      try {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [{
              updateSheetProperties: {
                // hidden: false ensures the new tab is always visible even if
                // the source sheet was hidden (a common template pattern).
                properties: { sheetId: newSheetId, title: tabName, hidden: false },
                fields: 'title,hidden',
              },
            }],
          },
        });
        renamed = true;
      } catch (err) {
        if (isNameConflict(err)) {
          tabName = `${baseName} ${counter++}`;
        } else {
          throw err;
        }
      }
    }

  } else {
    // ── Blank sheet path ─────────────────────────────────────────────────────
    // Add a fresh sheet and write debate-format column headers.
    // Same retry pattern in case of a name conflict.
    let sheetCreated = false;
    while (!sheetCreated) {
      try {
        const addRes = await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [{ addSheet: { properties: { title: tabName, hidden: false } } }],
          },
        });
        newSheetId = addRes.data.replies[0].addSheet.properties.sheetId;
        sheetCreated = true;
      } catch (err) {
        if (isNameConflict(err)) {
          tabName = `${baseName} ${counter++}`;
        } else {
          throw err;
        }
      }
    }

    const headers = FORMAT_HEADERS[format] || FORMAT_HEADERS.Policy;

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tabName}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [headers] },
    });

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            repeatCell: {
              range: { sheetId: newSheetId, startRowIndex: 0, endRowIndex: 1 },
              cell: { userEnteredFormat: { textFormat: { bold: true } } },
              fields: 'userEnteredFormat.textFormat.bold',
            },
          },
          {
            updateSheetProperties: {
              properties: { sheetId: newSheetId, gridProperties: { frozenRowCount: 1 } },
              fields: 'gridProperties.frozenRowCount',
            },
          },
          {
            updateDimensionProperties: {
              range: { sheetId: newSheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: headers.length },
              properties: { pixelSize: 160 },
              fields: 'pixelSize',
            },
          },
        ],
      },
    });
  }

  return { tabName, sheetId: newSheetId };
}

// Search for spreadsheets by name across My Drive, Shared Drives, and Shared with Me.
// Runs two queries in parallel (allDrives + sharedWithMe) because corpora:'allDrives'
// does not include files from the "Shared with me" virtual folder.
async function searchSheets(auth, query) {
  const drive = google.drive({ version: 'v3', auth });
  // Escape single quotes for Drive API query syntax
  const q = query.replace(/'/g, "\\'");

  const [allDrivesRes, sharedRes] = await Promise.all([
    // My Drive + all Shared Drives the user is a member of
    drive.files.list({
      q:       `name contains '${q}' and ${SHEET_FILTER} and trashed=false`,
      orderBy: 'modifiedTime desc',
      pageSize: 20,
      fields:  'files(id,name,mimeType,modifiedTime,webViewLink)',
      corpora:                   'allDrives',
      includeItemsFromAllDrives: true,
      supportsAllDrives:         true,
    }),
    // Files shared directly with the user (not in any drive the user owns)
    drive.files.list({
      q:       `sharedWithMe and name contains '${q}' and ${SHEET_FILTER} and trashed=false`,
      orderBy: 'modifiedTime desc',
      pageSize: 20,
      fields:  'files(id,name,mimeType,modifiedTime,webViewLink)',
      includeItemsFromAllDrives: true,
      supportsAllDrives:         true,
    }),
  ]);

  // Merge, deduplicate by id, then sort by recency
  const seen    = new Set();
  const results = [];
  for (const file of [...(allDrivesRes.data.files || []), ...(sharedRes.data.files || [])]) {
    if (!seen.has(file.id)) {
      seen.add(file.id);
      results.push(file);
    }
  }
  results.sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime));
  return results.slice(0, 20);
}

module.exports = { listFolder, listSharedWithMe, listSharedDrives, createFlowSheet, createFlowFromTemplate, addFlowTab, searchSheets };
