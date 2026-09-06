#!/usr/bin/env node
// One-off, run ONCE under your own Google login (NOT the service account).
// Creates one Google Sheet per outlet code in GOOGLE_DRIVE_FOLDER_ID and
// shares each with the service account as Editor, so api/sheet.js can
// write to them later. Not deployed, not imported by the app.
//
// Setup (one-time):
//   1. In the same Google Cloud project as the service account, create an
//      OAuth client of type "Desktop app" (APIs & Services > Credentials).
//   2. Set env vars before running:
//        GOOGLE_OAUTH_CLIENT_ID
//        GOOGLE_OAUTH_CLIENT_SECRET
//        GOOGLE_DRIVE_FOLDER_ID       (same folder api/outlet.js uses)
//        GOOGLE_SERVICE_ACCOUNT_EMAIL (same as GOOGLE_CLIENT_EMAIL in Vercel)
//   3. Preview only:  node scripts/create-outlet-sheets.js --dry-run
//      Create for real: node scripts/create-outlet-sheets.js
//
// Safe to re-run: skips any outlet code that already has a Sheet in the folder.

const http = require('http');
const { VALID_CODES } = require('../api/lib/outletCodes');

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const DRY_RUN = process.argv.includes('--dry-run');
const REDIRECT_PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/oauth2callback`;

function requireEnv() {
  const missing = ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_DRIVE_FOLDER_ID', 'GOOGLE_SERVICE_ACCOUNT_EMAIL']
    .filter((k) => !process.env[k]);
  if (missing.length) {
    console.error('Missing env vars: ' + missing.join(', '));
    process.exit(1);
  }
}

function getAuthCode() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      const code = url.searchParams.get('code');
      res.end(code ? 'Login complete, you can close this tab.' : 'No code received.');
      server.close();
      code ? resolve(code) : reject(new Error('No auth code in callback'));
    });
    server.listen(REDIRECT_PORT, () => {
      const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: 'https://www.googleapis.com/auth/drive',
        access_type: 'offline',
        prompt: 'consent',
      });
      console.log('Open this URL in your browser and log in:\n' + authUrl + '\n');
    });
  });
}

async function exchangeCodeForToken(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error('Token exchange failed: ' + JSON.stringify(json));
  return json.access_token;
}

async function findExistingSheet(token, code) {
  const q = `'${FOLDER_ID}' in parents and name = '${code}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  if (!res.ok) throw new Error('Drive lookup failed: ' + JSON.stringify(json));
  return (json.files && json.files[0]) || null;
}

async function createSheet(token, code) {
  const res = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: code,
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents: [FOLDER_ID],
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error('Create failed: ' + JSON.stringify(json));
  return json.id;
}

async function shareWithServiceAccount(token, fileId) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'writer', type: 'user', emailAddress: SERVICE_ACCOUNT_EMAIL }),
  });
  if (!res.ok) throw new Error('Share failed: ' + JSON.stringify(await res.json()));
}

async function main() {
  requireEnv();
  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Outlets to process: ${VALID_CODES.size}`);
  if (DRY_RUN) {
    [...VALID_CODES].forEach((code) => console.log(' - ' + code));
    return;
  }

  const authCode = await getAuthCode();
  const token = await exchangeCodeForToken(authCode);

  for (const code of VALID_CODES) {
    try {
      const existing = await findExistingSheet(token, code);
      if (existing) {
        console.log(`SKIP ${code} (already exists: ${existing.id})`);
        continue;
      }
      const fileId = await createSheet(token, code);
      await shareWithServiceAccount(token, fileId);
      console.log(`CREATED ${code} -> ${fileId}`);
    } catch (e) {
      console.error(`FAILED ${code}: ${e.message}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
