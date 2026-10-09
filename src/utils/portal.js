const PORTALS = {
  student: {
    id: 'student',
    label: 'Student',
    audience: 'Students',
    signupRole: 'student',
    allowsSignup: true,
  },
  teacher: {
    id: 'teacher',
    label: 'Teacher',
    audience: 'Teachers',
    signupRole: 'teacher',
    allowsSignup: true,
  },
  tutor: {
    id: 'tutor',
    label: 'Tutor',
    audience: 'Tutors',
    signupRole: 'tutor',
    allowsSignup: true,
  },
  parent: {
    id: 'parent',
    label: 'Parent',
    audience: 'Parents and caregivers',
    signupRole: 'parent',
    allowsSignup: true,
  },
  admin: {
    id: 'admin',
    label: 'Administrator',
    audience: 'Examifying administrators',
    signupRole: null,
    allowsSignup: false,
  },
};

const HOSTNAME_PORTALS = {
  examifying: 'student',
  tutors: 'tutor',
  teachers: 'teacher',
  parents: 'parent',
  admin: 'admin',
  teacher: 'teacher',
  tutor: 'tutor',
  parent: 'parent',
  'examifying-teachers': 'teacher',
  'examifying-tutors': 'tutor',
  'examifying-parents': 'parent',
  'examifying-admin': 'admin',
};

const PORTAL_SITE_URLS = {
  student: 'https://examifying.bakayise.com',
  teacher: 'https://teachers.examifying.bakayise.com',
  tutor: 'https://tutors.examifying.bakayise.com',
  parent: 'https://parents.examifying.bakayise.com',
  admin: 'https://admin.examifying.bakayise.com',
};

const isPortalId = (value) => Object.hasOwn(PORTALS, value);
const isTeacherProfile = (profile) => profile?.role === 'teacher'
  || profile?.isTeacher === true
  || profile?.isTeacher === 'true';

export const getPortal = (hostname = window.location.hostname) => {
  const configuredPortal = import.meta.env?.DEV
    ? import.meta.env.VITE_APP_PORTAL?.trim().toLowerCase()
    : '';
  if (isPortalId(configuredPortal)) return configuredPortal;

  const normalizedHostname = hostname.toLowerCase().replace(/^www\./, '');
  if (HOSTNAME_PORTALS[normalizedHostname]) return HOSTNAME_PORTALS[normalizedHostname];
  const hostLabel = normalizedHostname.split('.')[0];
  if (HOSTNAME_PORTALS[hostLabel]) return HOSTNAME_PORTALS[hostLabel];
  return 'student';
};

export const getPortalConfig = (portal = getPortal()) => PORTALS[portal] || PORTALS.student;

export const getPortalForProfile = (profile) => {
  if (!profile?.role) return null;
  if (profile.role === 'teacher' || (profile.role === 'tutor' && isTeacherProfile(profile))) return 'teacher';
  return ['student', 'tutor', 'parent', 'admin'].includes(profile.role) ? profile.role : null;
};

export const isProfileAllowedOnPortal = (profile, portal = getPortal()) =>
  getPortalForProfile(profile) === portal;

export const getPortalSiteUrl = (portal) => PORTAL_SITE_URLS[portal] || PORTAL_SITE_URLS.student;

export const getSignupPathForPortal = (portal = getPortal(), search = '') => {
  const config = getPortalConfig(portal);
  if (!config.allowsSignup) return null;

  const params = new URLSearchParams(search);
  params.set('role', config.signupRole);
  const query = params.toString();
  return query ? `/signup?${query}` : '/signup';
};
