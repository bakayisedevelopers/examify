import assert from 'node:assert/strict';
import test from 'node:test';
import { getWhatsAppChatUrl, normalizeWhatsAppLessonLink, normalizeWhatsAppNumber } from './whatsapp.js';

test('normalizes South African and international WhatsApp numbers', () => {
  assert.equal(normalizeWhatsAppNumber('082 123 4567'), '+27821234567');
  assert.equal(normalizeWhatsAppNumber('+44 20 1234 5678'), '+442012345678');
  assert.equal(getWhatsAppChatUrl('082 123 4567'), 'https://wa.me/27821234567');
});

test('rejects invalid phone numbers', () => {
  assert.throws(() => normalizeWhatsAppNumber('123'), /valid WhatsApp number/);
});

test('accepts supported WhatsApp lesson links and rejects other platforms', () => {
  assert.equal(normalizeWhatsAppLessonLink('https://call.whatsapp.com/abc'), 'https://call.whatsapp.com/abc');
  assert.equal(normalizeWhatsAppLessonLink('chat.whatsapp.com/invite-code'), 'https://chat.whatsapp.com/invite-code');
  assert.throws(() => normalizeWhatsAppLessonLink('https://zoom.us/j/123'), /must use WhatsApp/);
});
