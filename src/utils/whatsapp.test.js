import assert from 'node:assert/strict';
import test from 'node:test';
import { getWhatsAppChatUrl, normalizeWhatsAppGroupInviteLink, normalizeWhatsAppLessonLink, normalizeWhatsAppNumber } from './whatsapp.js';

test('normalizes South African and international WhatsApp numbers', () => {
  assert.equal(normalizeWhatsAppNumber('082 123 4567'), '+27821234567');
  assert.equal(normalizeWhatsAppNumber('+44 20 1234 5678'), '+442012345678');
  assert.equal(getWhatsAppChatUrl('082 123 4567'), 'https://wa.me/27821234567');
});

test('rejects invalid phone numbers', () => {
  assert.throws(() => normalizeWhatsAppNumber('123'), /valid WhatsApp number/);
  assert.throws(() => normalizeWhatsAppNumber('call +44 20 1234 5678'), /valid WhatsApp number/);
  assert.throws(() => normalizeWhatsAppNumber('++44 20 1234 5678'), /valid WhatsApp number/);
});

test('accepts supported WhatsApp lesson links and rejects other platforms', () => {
  assert.equal(normalizeWhatsAppLessonLink('https://call.whatsapp.com/abc'), 'https://call.whatsapp.com/abc');
  assert.equal(normalizeWhatsAppLessonLink('chat.whatsapp.com/invite-code'), 'https://chat.whatsapp.com/invite-code');
  assert.throws(() => normalizeWhatsAppLessonLink('https://zoom.us/j/123'), /must use WhatsApp/);
});

test('accepts only direct WhatsApp group invite links', () => {
  assert.equal(normalizeWhatsAppGroupInviteLink('chat.whatsapp.com/Abcde_123'), 'https://chat.whatsapp.com/Abcde_123');
  assert.throws(() => normalizeWhatsAppGroupInviteLink('https://wa.me/27821234567'), /group invite link/);
  assert.throws(() => normalizeWhatsAppGroupInviteLink('https://chat.whatsapp.com/Abcde?redirect=example.com'), /group invite link/);
});
