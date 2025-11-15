import express from 'express';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import pn from 'awesome-phonenumber';
import {
  makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  Browsers,
  jidNormalizedUser,
  fetchLatestBaileysVersion,
  delay
} from '@whiskeysockets/baileys';

const router = express.Router();
const log = pino({ level: 'fatal' }).child({ level: 'fatal' });

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function removeDir(dir) {
  try {
    if (!fs.existsSync(dir)) return;
    fs.rmSync(dir, { recursive: true, force: true });
    log.info({ dir }, 'Removed session directory');
  } catch (e) {
    log.error({ err: e }, 'Failed removing directory');
  }
}

// Helper to safely read a file
function safeRead(filePath) {
  try {
    return fs.readFileSync(filePath);
  } catch (e) {
    return null;
  }
}

router.get('/', async (req, res) => {
  let num = String(req.query.number || '').trim();
  if (!num) return res.status(400).send({ code: 'Missing phone number' });

  // Normalize phone with awesome-phonenumber and convert to E.164 without plus
  const phone = pn(num.startsWith('+') ? num : '+' + num);
  if (!phone.isValid()) {
    return res.status(400).send({ code: 'Invalid phone number. Provide full international number, e.g. 15551234567' });
  }

  num = phone.getNumber('e164').replace('+', '');
  const sessionDir = path.join(process.cwd(), `./${num}`);
  ensureDir(sessionDir);

  // create auth state
  let authState;
  try {
    authState = await useMultiFileAuthState(sessionDir);
  } catch (err) {
    log.error({ err }, 'useMultiFileAuthState failed');
    return res.status(500).send({ code: 'Auth initialization failed' });
  }

  // fetch latest baileys version
  let versionInfo;
  try {
    versionInfo = await fetchLatestBaileysVersion();
  } catch (err) {
    log.error({ err }, 'fetchLatestBaileysVersion failed — falling back to default');
    versionInfo = { version: undefined, isLatest: false };
  }

  const { state, saveCreds } = authState;

  // Make socket
  const sock = makeWASocket({
    version: versionInfo.version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, log)
    },
    logger: log,
    printQRInTerminal: false,
    browser: Browsers.windows('Chrome'),
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    defaultQueryTimeoutMs: 60000,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
  });

  // persist creds whenever updated
  sock.ev.on('creds.update', saveCreds);

  // track if response already sent
  let responded = false;
  const safeSend = (payload) => {
    if (responded) return;
    responded = true;
    try { res.send(payload); } catch (e) { /* ignore */ }
  };

  // handle connection updates
  sock.ev.on('connection.update', async (update) => {
    try {
      const { connection, lastDisconnect, isNewLogin, qr } = update;

      if (qr) {
        // In some Baileys versions the pairing flow uses QR — but when pairing by phone number, requestPairingCode is used.
        log.info('QR present in update (ignored for phone pairing)');
      }

      if (connection === 'open') {
        log.info('Connection open — authenticated');

        // Send creds.json and other messages to the user as requested (Option A)
        try {
          const credsFile = path.join(sessionDir, 'creds.json');
          const credsBuf = safeRead(credsFile);
          const userJid = jidNormalizedUser(num + '@s.whatsapp.net');

          if (credsBuf) {
            // send creds.json as document
            await sock.sendMessage(userJid, {
              document: credsBuf,
              mimetype: 'application/json',
              fileName: 'creds.json'
            });
            log.info('Sent creds.json to user');

            // send thumbnail + caption
            await sock.sendMessage(userJid, {
              image: { url: 'https://img.youtube.com/vi/-oz_u1iMgf8/maxresdefault.jpg' },
              caption: `🎬 *KnightBot MD V2.0 Full Setup Guide!*\n\n🚀 Bug Fixes + New Commands + Fast AI Chat\n📺 Watch Now: https://youtu.be/-oz_u1iMgf8`
            });
            log.info('Sent guide thumbnail');

            // send warning
            await sock.sendMessage(userJid, {
              text: `⚠️Do not share this file with anybody⚠️\n\n┌┤✑  Thanks for using Knight Bot\n│└────────────┈ ⳹\n│©2024 Mr Unique Hacker\n└─────────────────┈ ⳹\n\n`
            });
            log.info('Sent warning message');
          } else {
            log.warn('creds.json not found to send to the user');
          }
        } catch (err) {
          log.error({ err }, 'Failed while sending post-login messages');
        }

        // schedule cleanup: wait a little bit then remove session dir
        try {
          await delay(2000);
          removeDir(sessionDir);
          log.info('Cleanup complete after successful connection');
        } catch (e) {
          log.error({ err: e }, 'Cleanup after connection failed');
        }
      }

      if (update.isNewLogin) {
        log.info('New login event');
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        log.info({ statusCode }, 'Connection closed');

        // If 401 then we were logged out and must regenerate pairing code next time
        if (statusCode === 401) {
          log.info('Logged out (401). New pair code required');
        }

        // Close the socket gracefully to avoid orphaned sockets
        try { sock.end(); } catch (e) { /* ignore */ }
      }
    } catch (e) {
      log.error({ err: e }, 'Error in connection.update handler');
    }
  });

  // If not registered, request pairing code and send to HTTP client
  (async () => {
    try {
      if (!state.creds?.registered) {
        log.info('Not registered — requesting pairing code for', num);

        try {
          // requestPairingCode expects the phone number in E.164 without '+'
          let pairCode = await sock.requestPairingCode(num);

          // pairCode might already be formatted or may be an object/string depending on baileys version
          if (!pairCode) {
            safeSend({ code: 'No pair code returned' });
            return;
          }

          // if the code is an object with code property, extract
          if (typeof pairCode === 'object' && pairCode.code) pairCode = pairCode.code;

          // format the code as XXXX-XXXX if reasonable
          const cleaned = String(pairCode).replace(/[^0-9]/g, '');
          const formatted = cleaned.match(/.{1,4}/g)?.join('-') || String(pairCode);

          safeSend({ code: formatted });
          log.info({ num, formatted }, 'Sent pair code to HTTP client');
        } catch (err) {
          log.error({ err }, 'requestPairingCode failed');
          safeSend({ code: 'Failed to get pairing code. Please try again later.' });
        }
      } else {
        // already registered — nothing to do
        safeSend({ code: 'Already registered — no pairing required' });
      }
    } catch (err) {
      log.error({ err }, 'Error while attempting to request pairing code');
      if (!responded) res.status(500).send({ code: 'Internal error' });
    }
  })();

});

// graceful uncaught exception handling (log and ignore a set of known transient errors)
process.on('uncaughtException', (err) => {
  const e = String(err);
  const ignored = [
    'conflict',
    'not-authorized',
    'Socket connection timeout',
    'rate-overlimit',
    'Connection Closed',
    'Timed Out',
    'Value not found',
    'Stream Errored',
    'statusCode: 515',
    'statusCode: 503'
  ];

  for (const ig of ignored) if (e.includes(ig)) return;
  console.error('Caught exception: ', err);
});

export default router;
    
