import { createHash } from 'node:crypto';
import { logger } from 'firebase-functions';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { admin, getDb } from './admin.js';

const FROM = 'Examifying <notifications@mail.bakayise.com>';
const APP_URL = 'https://examifying.web.app';
const OUTBOX = 'emailNotificationOutbox';
const MAX_ATTEMPTS = 8;
const LOCK_TIMEOUT_MS = 10 * 60 * 1000;

const escapeHtml = (value = '') => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase();
const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const emailJobId = ({ type, eventId, email }) => createHash('sha256')
  .update(`${type}|${eventId}|${normalizeEmail(email)}`)
  .digest('hex');

const absoluteAppUrl = (path = '/') => {
  if (/^https:\/\//i.test(path)) return path;
  return new URL(path.startsWith('/') ? path : `/${path}`, APP_URL).toString();
};

const renderEmail = ({ name, heading, paragraphs = [], details = [], actionLabel, actionUrl }) => {
  const greeting = name ? `Hi ${name},` : 'Hello,';
  const htmlParagraphs = paragraphs.map((paragraph) => (
    `<p style="margin:0 0 16px;color:#cbd5e1;font-size:15px;line-height:1.7">${escapeHtml(paragraph)}</p>`
  )).join('');
  const textDetails = details.map(({ label, value }) => `${label}: ${value}`).join('\n');
  const htmlDetails = details.length ? `
    <table role="presentation" style="width:100%;border-collapse:collapse;margin:20px 0;background:#111c2e;border:1px solid #26364b;border-radius:12px">
      ${details.map(({ label, value }) => `<tr><td style="padding:12px 14px;color:#94a3b8;font-size:13px;border-bottom:1px solid #26364b">${escapeHtml(label)}</td><td style="padding:12px 14px;color:#f8fafc;font-size:13px;font-weight:600;text-align:right;border-bottom:1px solid #26364b">${escapeHtml(value)}</td></tr>`).join('')}
    </table>` : '';
  const safeActionUrl = actionUrl ? escapeHtml(absoluteAppUrl(actionUrl)) : '';
  const action = actionLabel && actionUrl ? `
    <p style="margin:26px 0 8px">
      <a href="${safeActionUrl}" style="display:inline-block;border-radius:10px;background:#a3e635;background-image:linear-gradient(100deg,#bef264,#34d399);padding:13px 20px;color:#10210a;font-size:14px;font-weight:700;text-decoration:none">${escapeHtml(actionLabel)}</a>
    </p>` : '';
  const plainText = [greeting, '', heading, ...paragraphs, ...(textDetails ? ['', textDetails] : []), ...(actionUrl ? ['', `${actionLabel}: ${absoluteAppUrl(actionUrl)}`] : []), '', 'Examifying — learn with purpose.'].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#020617;font-family:Arial,Helvetica,sans-serif;color:#f8fafc">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(paragraphs[0] || heading)}</div>
    <table role="presentation" style="width:100%;background:#020617;padding:32px 12px"><tr><td align="center">
      <table role="presentation" style="width:100%;max-width:600px;border-collapse:separate;border-spacing:0;background:#0b1220;border:1px solid #1e293b;border-radius:20px;overflow:hidden">
        <tr><td style="padding:22px 28px;border-bottom:1px solid #1e293b;background:#0f172a">
          <table role="presentation"><tr><td style="vertical-align:middle"><img src="${APP_URL}/logo.png" width="42" height="42" alt="Examifying" style="display:block;border:0;border-radius:10px" /></td><td style="padding-left:12px;vertical-align:middle"><span style="font-size:20px;font-weight:800;letter-spacing:-.4px;color:#a3e635">Examifying</span><br /><span style="font-size:11px;letter-spacing:1.8px;text-transform:uppercase;color:#94a3b8">Learn with purpose</span></td></tr></table>
        </td></tr>
        <tr><td style="padding:30px 28px 32px">
          <p style="margin:0 0 8px;color:#bef264;font-size:13px;font-weight:700">${escapeHtml(greeting)}</p>
          <h1 style="margin:0 0 20px;color:#f8fafc;font-size:25px;line-height:1.25">${escapeHtml(heading)}</h1>
          ${htmlParagraphs}${htmlDetails}${action}
          <p style="margin:26px 0 0;color:#64748b;font-size:12px;line-height:1.6">This is an account or service notification from Examifying.</p>
        </td></tr>
        <tr><td style="padding:18px 28px;border-top:1px solid #1e293b;color:#64748b;font-size:12px">Examifying · <a href="${APP_URL}" style="color:#a3e635;text-decoration:none">examifying.web.app</a></td></tr>
      </table>
    </td></tr></table>
  </body></html>`;
  return { html, text: plainText };
};

export const queueBrandedEmail = async ({
  type,
  eventId,
  to,
  name = '',
  subject,
  heading,
  paragraphs = [],
  details = [],
  actionLabel,
  actionUrl,
}) => {
  const email = normalizeEmail(to);
  if (!validEmail(email) || !type || !eventId || !subject || !heading) return null;

  const id = emailJobId({ type, eventId, email });
  const rendered = renderEmail({ name, heading, paragraphs, details, actionLabel, actionUrl });
  const ref = getDb().collection(OUTBOX).doc(id);
  await getDb().runTransaction(async (transaction) => {
    const current = await transaction.get(ref);
    if (current.exists) return;
    transaction.create(ref, {
      id,
      type,
      eventId: String(eventId),
      to: email,
      from: FROM,
      subject,
      ...rendered,
      status: 'queued',
      attempts: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
  return id;
};

const claimEmail = async (ref) => getDb().runTransaction(async (transaction) => {
  const snapshot = await transaction.get(ref);
  if (!snapshot.exists) return null;
  const data = snapshot.data();
  const now = Date.now();
  const nextAttemptAt = data.nextAttemptAt?.toDate?.()?.getTime?.() ?? 0;
  const lockedAt = data.lockedAt?.toDate?.()?.getTime?.() ?? 0;
  if (['sent', 'failed'].includes(data.status) || nextAttemptAt > now) return null;
  if (data.status === 'sending' && now - lockedAt < LOCK_TIMEOUT_MS) return null;
  const attempts = Number(data.attempts || 0) + 1;
  if (attempts > MAX_ATTEMPTS) {
    transaction.update(ref, {
      status: 'failed',
      lastError: 'Email delivery exceeded retry limit.',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return null;
  }
  transaction.update(ref, {
    status: 'sending',
    attempts,
    lockedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { ...data, attempts };
});

const sendWithResend = async ({ apiKey, jobId, message }) => {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `examifying/${jobId}`,
    },
    body: JSON.stringify({
      from: message.from,
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`Resend rejected the email request (${response.status}).`);
    error.statusCode = response.status;
    error.providerName = result.name || result.error || null;
    throw error;
  }
  return result;
};

export const processResendEmailOutbox = onSchedule({
  schedule: 'every 1 minutes',
  timeZone: 'Etc/UTC',
  timeoutSeconds: 120,
  memory: '256MiB',
}, async () => {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    logger.error('RESEND_API_KEY is not configured in the Functions environment.');
    return;
  }

  const db = getDb();
  const queue = await db.collection(OUTBOX)
    .where('status', 'in', ['queued', 'sending'])
    .limit(100)
    .get();
  for (const document of queue.docs) {
    const message = await claimEmail(document.ref);
    if (!message) continue;
    try {
      const result = await sendWithResend({ apiKey, jobId: document.id, message });
      await document.ref.set({
        status: 'sent',
        resendId: result.id || null,
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        lockedAt: admin.firestore.FieldValue.delete(),
        nextAttemptAt: admin.firestore.FieldValue.delete(),
        lastError: admin.firestore.FieldValue.delete(),
      }, { merge: true });
    } catch (error) {
      const terminal = [400, 401, 403, 404].includes(error.statusCode) || message.attempts >= MAX_ATTEMPTS;
      const delayMs = Math.min(60 * 60 * 1000, 30 * 1000 * (2 ** Math.min(message.attempts - 1, 7)));
      await document.ref.set({
        status: terminal ? 'failed' : 'queued',
        nextAttemptAt: terminal ? admin.firestore.FieldValue.delete() : admin.firestore.Timestamp.fromDate(new Date(Date.now() + delayMs)),
        lastError: String(error.message || 'Email delivery failed.').slice(0, 250),
        lastProviderError: error.providerName || null,
        lockedAt: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      logger.error('Resend email delivery failed', {
        jobId: document.id,
        type: message.type,
        statusCode: error.statusCode || null,
        attempt: message.attempts,
        terminal,
      });
    }
  }
});
