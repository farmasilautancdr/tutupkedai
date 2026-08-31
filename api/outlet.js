// Vercel serverless function: GET/POST /api/outlet?code=<outletCode>
// Reads/writes one outlet's slice of a single combined JSON file
// ("tutupkedai-data.json") in a Drive folder, authenticating as a Google
// service account (no per-user OAuth login).
//
// IMPORTANT: service accounts have zero Drive storage quota of their own,
// so they can UPDATE a file they don't own but cannot CREATE a new one in
// someone else's folder (fails with storageQuotaExceeded) unless you're on
// a paid Google Workspace Shared Drive. To keep this free on a personal
// Google account, a human must create the (empty) data file once, by hand,
// in the shared folder — see MEMORY.md/CLAUDE.md for the one-time step.
// After that this function only ever PATCHes that existing file.
//
// Required env vars (set in Vercel dashboard, never committed):
//   GOOGLE_CLIENT_EMAIL      - service account client_email
//   GOOGLE_PRIVATE_KEY       - service account private_key (with real or \n-escaped newlines)
//   GOOGLE_DRIVE_FOLDER_ID   - Drive folder the service account was shared on

const crypto = require('crypto');

const DATA_FILENAME = 'tutupkedai-data.json';

// Mirrors `allOutlets` in index.html. Keep the two lists in sync.
const VALID_CODES = new Set([
  "AJ","B6","BB","BG","BJR","BP","CDR","CK","DG","DGD","GB","GBD","GM","HL","HQ","HQCT",
  "JL","JLD","JTH","KB","KBKK","KBKS","KBTJ","KKR","KL","KMD","KMN","KMSK","KS","MC","MCD",
  "MLR","MR","PC","PDM","PK","PM","PP","PPK","PSPD","PT","RJ","SLS","SMR","ST","TM","TMD",
  "TMT","TPOH","TPT","WM"
]);

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken() {
  const email = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: email,
    scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const signature = signer.sign(privateKey).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const jwt = `${unsigned}.${signature}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const json = await tokenRes.json();
  if (!tokenRes.ok) throw new Error('Google token exchange failed: ' + JSON.stringify(json));
  return json.access_token;
}

async function findDataFile(token, folderId) {
  const q = `'${folderId}' in parents and name = '${DATA_FILENAME}' and trashed = false`;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  if (!res.ok) throw new Error('Drive file lookup failed: ' + JSON.stringify(json));
  return (json.files && json.files[0]) || null;
}

async function readDataFile(token, fileId) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error('Drive file read failed: ' + text);
  try {
    const parsed = JSON.parse(text || '{}');
    return (parsed && typeof parsed === 'object' && parsed.outlets) ? parsed : { outlets: {} };
  } catch {
    return { outlets: {} };
  }
}

async function writeDataFile(token, fileId, data) {
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Drive file write failed: ' + (await res.text()));
}

module.exports = async (req, res) => {
  try {
    const code = String(req.query.code || '');
    if (!VALID_CODES.has(code)) {
      res.status(400).json({ error: 'invalid outlet code' });
      return;
    }

    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    const token = await getAccessToken();
    const dataFile = await findDataFile(token, folderId);

    if (!dataFile) {
      res.status(503).json({
        error: `${DATA_FILENAME} not found in the Drive folder. A human must create it once by hand ` +
               `(upload an empty file containing "{}") — service accounts can't create new files there, only update existing ones.`,
      });
      return;
    }

    if (req.method === 'GET') {
      const data = await readDataFile(token, dataFile.id);
      res.status(200).json(data.outlets[code] || { config: null, scanHistory: [] });
      return;
    }

    if (req.method === 'POST') {
      const body = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
      const entry = {
        config: body.config || null,
        scanHistory: Array.isArray(body.scanHistory) ? body.scanHistory : [],
      };
      // Read-modify-write of the whole shared file. Fine at this app's scale
      // (a handful of outlets saved by staff, not truly concurrent writers),
      // but two terminals updating DIFFERENT outlets within the same instant
      // could theoretically race and one write could clobber the other's.
      const data = await readDataFile(token, dataFile.id);
      data.outlets[code] = entry;
      await writeDataFile(token, dataFile.id, data);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};
