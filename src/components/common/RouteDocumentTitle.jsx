import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';

const roleTitles = {
  admin: 'Admin',
  parent: 'Parent',
  student: 'Student',
  teacher: 'Teacher',
  tutor: 'Tutor',
};

const pageTitles = {
  admin: { users: 'Users', payments: 'Payments', settings: 'Settings', papers: 'Question papers' },
  parent: { profile: 'Profile' },
  student: { billing: 'Billing', exercises: 'Exercises', lessons: 'Lessons', papers: 'Question papers', 'peer-reviews': 'Peer reviews', profile: 'Profile', guide: 'Guide' },
  teacher: { exercises: 'Exercises', guide: 'Guide', lessons: 'Lessons', papers: 'Question papers', profile: 'Profile', reports: 'Reports', students: 'Students' },
  tutor: { exercises: 'Exercises', guide: 'Guide', lessons: 'Lessons', papers: 'Question papers', profile: 'Profile', reports: 'Reports', students: 'Students' },
};

const getPageTitle = (pathname, role) => {
  const parts = pathname.split('/').filter(Boolean);
  const roleSegment = ['admin', 'parent', 'student', 'teacher', 'tutor'].includes(parts[0]) ? parts.shift() : null;
  if (!roleSegment) {
    if (pathname === '/') return 'Home';
    if (pathname === '/login') return 'Sign in';
    if (pathname === '/signup') return 'Create account';
    if (pathname === '/policies') return 'Policies';
    return 'Examifying';
  }
  if (!parts.length) return 'Home';
  const [section, detail] = parts;
  if (section === 'profile') return 'Profile';
  if (section === 'students' && detail) return 'Student details';
  if (['exercises', 'lessons', 'papers'].includes(section) && detail) {
    return { exercises: 'Exercise details', lessons: 'Lesson details', papers: 'Question paper' }[section];
  }
  return pageTitles[role]?.[section] || pageTitles[roleSegment]?.[section] || 'Home';
};

export const RouteDocumentTitle = () => {
  const { pathname } = useLocation();
  const { profile } = useAuth();

  useEffect(() => {
    if (pathname === '/') {
      document.title = 'Examifying';
      return;
    }
    const pathRole = pathname.split('/').filter(Boolean)[0];
    const normalizedRole = profile?.isTeacher || pathRole === 'teacher'
      ? 'teacher'
      : (profile?.role || (roleTitles[pathRole] ? pathRole : null));
    const roleTitle = roleTitles[normalizedRole];
    const pageTitle = getPageTitle(pathname, normalizedRole || pathRole);
    document.title = roleTitle ? `${roleTitle} | ${pageTitle}` : `Examifying | ${pageTitle}`;
  }, [pathname, profile?.isTeacher, profile?.role]);

  return null;
};
