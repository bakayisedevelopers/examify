import test from 'node:test';
import assert from 'node:assert/strict';
import { getPortal, getPortalForProfile, getPortalSiteUrl } from './portal.js';

test('maps each production hostname to its role portal', () => {
  const hostnamePortals = {
    'examifying.bakayise.com': 'student',
    'admin.examifying.bakayise.com': 'admin',
    'tutors.examifying.bakayise.com': 'tutor',
    'teachers.examifying.bakayise.com': 'teacher',
    'parents.examifying.bakayise.com': 'parent',
  };

  for (const [hostname, portal] of Object.entries(hostnamePortals)) {
    assert.equal(getPortal(hostname), portal, hostname);
  }
});

test('retains Firebase Hosting role domains and teacher-profile routing', () => {
  assert.equal(getPortal('examifying-tutors.web.app'), 'tutor');
  assert.equal(getPortal('examifying-teachers.web.app'), 'teacher');
  assert.equal(getPortal('examifying-parents.web.app'), 'parent');
  assert.equal(getPortal('examifying-admin.web.app'), 'admin');
  assert.equal(getPortalForProfile({ role: 'tutor', isTeacher: true }), 'teacher');
});

test('uses the configured custom domain when linking to a role portal', () => {
  assert.equal(getPortalSiteUrl('student'), 'https://examifying.bakayise.com');
  assert.equal(getPortalSiteUrl('admin'), 'https://admin.examifying.bakayise.com');
  assert.equal(getPortalSiteUrl('tutor'), 'https://tutors.examifying.bakayise.com');
  assert.equal(getPortalSiteUrl('teacher'), 'https://teachers.examifying.bakayise.com');
  assert.equal(getPortalSiteUrl('parent'), 'https://parents.examifying.bakayise.com');
});
