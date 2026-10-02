export const normalizeWhatsAppNumber = (value = '') => {
  const input = String(value).trim();
  let digits = input.replace(/\D/g, '');
  if (input.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 10 && digits.startsWith('0')) digits = `27${digits.slice(1)}`;
  if (!/^[1-9]\d{7,14}$/.test(digits)) {
    throw new Error('Enter a valid WhatsApp number with its country code, or a South African number beginning with 0.');
  }
  return `+${digits}`;
};

export const getWhatsAppChatUrl = (value = '') => {
  try {
    return `https://wa.me/${normalizeWhatsAppNumber(value).slice(1)}`;
  } catch {
    return '';
  }
};

export const normalizeWhatsAppLessonLink = (value = '') => {
  const input = String(value).trim();
  if (!input) return '';
  const candidate = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('Enter a valid WhatsApp lesson or group-invite link.');
  }
  const host = url.hostname.toLowerCase();
  const allowedHosts = new Set(['wa.me', 'api.whatsapp.com', 'web.whatsapp.com', 'chat.whatsapp.com', 'call.whatsapp.com', 'www.whatsapp.com']);
  if (url.protocol !== 'https:' || !allowedHosts.has(host)) {
    throw new Error('Online lesson links must use WhatsApp (wa.me, call.whatsapp.com, or chat.whatsapp.com).');
  }
  return url.toString();
};
