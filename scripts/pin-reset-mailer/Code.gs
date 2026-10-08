/**
 * Alpha Premier Attendance - admin PIN reset mailer (free Google Apps Script web app).
 *
 * The desktop app POSTs {"code":"123456","requestId":"A1B2C3","requestedAt":"<ISO>"}
 * here and this script emails the code to the company inbox. The recipient is
 * fixed below, so a reset code can never be sent anywhere else. The URL is
 * readable from the shipped app, so treat it as public: sends are capped per
 * hour, and the kiosk shows the request ID so admins can ignore fake emails.
 * Codes expire after 15 minutes and only work on the kiosk that requested them.
 *
 * Deployed with clasp (Google's Apps Script CLI) from this folder while signed in
 * as thealphapremiergroup@gmail.com: clasp create --type webapp, clasp push,
 * clasp deploy. Opening the /exec URL once as that account grants the
 * send-mail permission (doGet below). The URL goes into the GitHub secret
 * ALPHA_PREMIER_PIN_RESET_URL, which release builds bake into the app.
 */
const RECIPIENT = 'thealphapremiergroup@gmail.com';
// 3 per hour stays under the ~100/day consumer Gmail quota for any rolling 24h.
const MAX_EMAILS_PER_HOUR = 3;

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (error) {
    return reply(false, 'BAD_REQUEST');
  }
  const code = String(body.code || '');
  const requestId = String(body.requestId || '');
  if (!/^\d{6}$/.test(code) || !/^[0-9A-F]{6}$/.test(requestId)) return reply(false, 'BAD_REQUEST');
  if (!takeSendSlot()) return reply(false, 'RATE_LIMITED');

  const when = Utilities.formatDate(new Date(), 'Asia/Manila', 'MMM d, yyyy h:mm a');
  MailApp.sendEmail({
    to: RECIPIENT,
    subject: 'Alpha Premier Attendance: admin PIN reset code (request ' + requestId + ')',
    body:
      'An admin PIN reset was requested on the attendance kiosk at ' + when + ' (Manila).\n\n' +
      'Request ID: ' + requestId + ' (must match the ID shown on the kiosk)\n' +
      'Reset code: ' + code + '\n\n' +
      'Enter it on the kiosk with the new PIN. It expires in 15 minutes.\n' +
      'If nobody requested this, ignore this email. The current PIN and admin RFID cards keep working.',
  });
  return reply(true, null);
}

/** Atomic per-hour send counter; keeps spam under the Gmail daily quota. */
function takeSendSlot() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return false;
  try {
    const props = PropertiesService.getScriptProperties();
    const hour = String(Math.floor(Date.now() / 3600000));
    const state = JSON.parse(props.getProperty('sendCounter') || '{}');
    const count = state.hour === hour ? state.count : 0;
    if (count >= MAX_EMAILS_PER_HOUR) return false;
    props.setProperty('sendCounter', JSON.stringify({ hour: hour, count: count + 1 }));
    return true;
  } finally {
    lock.releaseLock();
  }
}

/** Health check; opening it as the owner also triggers the one-time send-mail consent. */
function doGet() {
  return ContentService.createTextOutput(
    JSON.stringify({ success: true, service: 'pin-reset-mailer', remainingDailyQuota: MailApp.getRemainingDailyQuota() }),
  ).setMimeType(ContentService.MimeType.JSON);
}

function reply(success, error) {
  return ContentService.createTextOutput(JSON.stringify({ success: success, error: error }))
    .setMimeType(ContentService.MimeType.JSON);
}
