const express = require('express');
const { default: WaPairing, useMultiFileAuthState, PHONENUMBER_MCC } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Directory to store authentication states
const authDir = path.join(__dirname, 'auth');

// Utility to check and create auth directory
if (!fs.existsSync(authDir)) {
  fs.mkdirSync(authDir);
}

// Function to sanitize phone number
function sanitizePhoneNumber(phoneNumber) {
  return phoneNumber.replace(/[^0-9]/g, "");
}

// Session Manager to handle multiple instances
const sessionManager = {
  sessions: {},
  getSession: function(phoneNumber) {
    const sanitizedPhoneNumber = sanitizePhoneNumber(phoneNumber);
    if (!this.sessions[sanitizedPhoneNumber]) {
      this.sessions[sanitizedPhoneNumber] = this.createSession(sanitizedPhoneNumber);
    }
    return this.sessions[sanitizedPhoneNumber];
  },
  createSession: function(sanitizedPhoneNumber) {
    const sessionDir = path.join(authDir, sanitizedPhoneNumber);
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir);
    }
    return useMultiFileAuthState(sessionDir);
  },
  clearSession: function(phoneNumber) {
    const sanitizedPhoneNumber = sanitizePhoneNumber(phoneNumber);
    delete this.sessions[sanitizedPhoneNumber];
    const sessionDir = path.join(authDir, sanitizedPhoneNumber);
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  }
};

// Connection function
async function WaConnect(phoneNumber, attempt = 0) {
  const sanitizedPhoneNumber = sanitizePhoneNumber(phoneNumber);
  const { state, saveCreds } = await sessionManager.getSession(phoneNumber);

  const socket = WaPairing({
    version: [2, 2323, 4],
    printQRInTerminal: false,
    logger: pino({ level: 'info' }),
    browser: ['Chrome (Linux)', '', ''],
    auth: state,
  });

  socket.ev.on('creds.update', saveCreds);

  if (!socket.authState.creds.registered) {
    if (!Object.keys(PHONENUMBER_MCC).some(v => sanitizedPhoneNumber.startsWith(v))) {
      throw new Error('Invalid phone number. Enter the phone number with your country code, e.g., +628XXXXXXXX');
    }

    return new Promise((resolve, reject) => {
      setTimeout(async () => {
        try {
          let code = await socket.requestPairingCode(sanitizedPhoneNumber);
          code = code.match(/.{1,4}/g).join('-') || code;
          console.log('Your Pairing Code: \n' + code);
          resolve(code);
        } catch (error) {
          reject(error);
        }
      }, 3000);
    });
  }

  socket.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      console.log(`Connected to WhatsApp for ${phoneNumber} successfully!`);
    } else if (connection === 'close') {
      const shouldReconnect = lastDisconnect.error?.output?.statusCode !== 401;
      console.log(`Connection closed. Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(() => WaConnect(phoneNumber, attempt + 1), 5000); // Avoid rapid reconnect attempts
      } else {
        console.log('Connection closed due to authentication failure.');
        sessionManager.clearSession(phoneNumber);
        console.log('Session cleared. Trying to obtain a new pairing code.');
        try {
          const pairingCode = await WaConnect(phoneNumber);
          console.log(`New pairing code for ${phoneNumber}: ${pairingCode}`);
        } catch (error) {
          console.error(`Failed to obtain new pairing code: ${error.message}`);
        }
      }
    }
  });

  socket.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0];
    if (!m.message) return;
    const msgType = Object.keys(m.message)[0];
    const msgText =
      msgType === 'conversation' ? m.message.conversation :
      msgType === 'extendedTextMessage' ? m.message.extendedTextMessage.text :
      msgType === 'imageMessage' ? m.message.imageMessage.caption :
      '';

    if (msgText.toLowerCase() === 'hi') {
      socket.sendMessage(m.key.remoteJid, { text: 'hello' }, { quoted: m });
    }
  });

  socket.ev.on('error', (err) => {
    console.error('An error occurred:', err);
    if (attempt < 5) {
      console.log(`Attempting to reconnect (${attempt + 1}/5)...`);
      setTimeout(() => WaConnect(phoneNumber, attempt + 1), 5000);
    } else {
      console.log('Max reconnection attempts reached. Clearing session.');
      sessionManager.clearSession(phoneNumber);
    }
  });

  return socket;
}

// Express route to handle phone number submission and pairing code response
app.get('/pair', async (req, res) => {
  const { phoneNumber } = req.query;
  if (!phoneNumber) {
    return res.status(400).json({ error: 'Phone number is required' });
  }

  try {
    const pairingCode = await WaConnect(phoneNumber);
    res.json({ pairingCode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
