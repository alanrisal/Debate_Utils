'use strict';

const { google } = require('googleapis');
const crypto = require('crypto');
const http = require('http');
const { shell } = require('electron');

const REDIRECT_PORT = 42813;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`;

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.readonly',  // view files in user's Drive
  'https://www.googleapis.com/auth/drive.file',  // create/edit files the app opens
  'email',
  'profile',
];

function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    REDIRECT_URI
  );
}

function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function waitForAuthCode(port) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error('OAuth timeout — no code received within 5 minutes'));
    }, 5 * 60 * 1000);

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html>
<html><head>
  <meta charset="utf-8">
  <title>FlowKit — Connected</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0e0e0e; color: #e2e2e2; font-family: system-ui, sans-serif;
           display: flex; align-items: center; justify-content: center; height: 100vh; }
    .card { text-align: center; max-width: 360px; }
    .check { font-size: 2.5rem; margin-bottom: 16px; }
    h1 { font-size: 1.4rem; font-weight: 600; margin-bottom: 12px; }
    p { font-size: 0.88rem; color: #888; }
  </style>
</head><body>
  <div class="card">
    <div class="check">✓</div>
    <h1>Connected to Google</h1>
    <p>You can close this tab and return to FlowKit.</p>
  </div>
</body></html>`);
        clearTimeout(timeout);
        server.close();
        resolve(code);
      } else if (error) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end(`Auth error: ${error}`);
        clearTimeout(timeout);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    server.listen(port, () => { /* ready */ });

    server.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function startAuthFlow() {
  const client = createOAuth2Client();
  const { verifier, challenge } = generatePKCE();

  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'consent',
  });

  shell.openExternal(authUrl);

  const code = await waitForAuthCode(REDIRECT_PORT);

  const { tokens } = await client.getToken({ code, codeVerifier: verifier });
  client.setCredentials(tokens);

  const oauth2Api = google.oauth2({ version: 'v2', auth: client });
  const { data: userInfo } = await oauth2Api.userinfo.get();

  return { tokens, userInfo, client };
}

function buildClientFromTokens(tokens) {
  const client = createOAuth2Client();
  client.setCredentials(tokens);
  return client;
}

module.exports = { startAuthFlow, buildClientFromTokens, createOAuth2Client };
