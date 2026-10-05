export const normalizeWhatsAppNumber = (value = '') => {
  const input = String(value).trim();
  if (!input || !/^[+\d\s().-]+$/.test(input)) {
    throw new Error('Enter a valid WhatsApp number with its country code, or a South African number beginning with 0.');
  }
  const compact = input.replace(/[\s().-]/g, '');
  if ((compact.match(/\+/g) || []).length > 1 || (compact.includes('+') && !compact.startsWith('+'))) {
    throw new Error('Enter a valid WhatsApp number with its country code, or a South African number beginning with 0.');
  }
  let digits = compact.replace(/^\+/, '');
  if (digits.startsWith('00') && !compact.startsWith('+')) digits = digits.slice(2);
  if (!compact.startsWith('+') && digits.length === 10 && digits.startsWith('0')) digits = `27${digits.slice(1)}`;
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

export const normalizeWhatsAppGroupInviteLink = (value = '') => {
  const input = String(value).trim();
  if (!input) return '';
  let url;
  try {
    url = new URL(/^https:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new Error('Enter a valid WhatsApp group invite link.');
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'chat.whatsapp.com'
    || url.username || url.password || url.search || url.hash
    || !/^\/[A-Za-z0-9_-]{5,}\/?$/.test(url.pathname)) {
    throw new Error('Use a WhatsApp group invite link from chat.whatsapp.com.');
  }
  return `https://chat.whatsapp.com/${url.pathname.split('/').filter(Boolean)[0]}`;
};
