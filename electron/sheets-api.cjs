'use strict';

const { google } = require('googleapis');

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

module.exports = { listFolder, listSharedWithMe, listSharedDrives };
