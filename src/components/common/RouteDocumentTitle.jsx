import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { buildStructuredData, getRouteSeo } from '../../config/seo';
import { getPortal } from '../../utils/portal';

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
  student: { billing: 'Subscription', exercises: 'Exercises', lessons: 'Lessons', papers: 'Question papers', 'peer-reviews': 'Peer reviews', profile: 'Profile', guide: 'Guide' },
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
  const portal = getPortal();

  useEffect(() => {
    const routeSeo = getRouteSeo(pathname, portal);
    const pathRole = pathname.split('/').filter(Boolean)[0];
    const normalizedRole = profile?.isTeacher || pathRole === 'teacher'
      ? 'teacher'
      : (profile?.role || (roleTitles[pathRole] ? pathRole : null));

    if (pathname === '/' || pathname === '/login' || pathname === '/signup' || pathname === '/policies') {
      document.title = routeSeo.title;
    } else {
      const roleTitle = roleTitles[normalizedRole];
      const pageTitle = getPageTitle(pathname, normalizedRole || pathRole);
      document.title = roleTitle ? `${roleTitle} | ${pageTitle}` : `Examifying | ${pageTitle}`;
    }

    const setMeta = (selector, attribute, value) => {
      let element = document.head.querySelector(selector);
      if (!value) {
        element?.remove();
        return;
      }
      if (!element) {
        element = document.createElement('meta');
        document.head.appendChild(element);
      }
      element.setAttribute(attribute, value);
    };

    setMeta('meta[name="description"]', 'content', routeSeo.description);
    setMeta('meta[name="keywords"]', 'content', routeSeo.keywords);
    setMeta('meta[name="robots"]', 'content', routeSeo.robots);
    setMeta('meta[property="og:title"]', 'content', document.title);
    setMeta('meta[property="og:description"]', 'content', routeSeo.description);
    setMeta('meta[property="og:url"]', 'content', routeSeo.url || `${window.location.origin}${pathname}`);
    setMeta('meta[property="og:image"]', 'content', `${window.location.origin}/logo.png`);
    setMeta('meta[name="twitter:title"]', 'content', document.title);
    setMeta('meta[name="twitter:description"]', 'content', routeSeo.description);
    setMeta('meta[name="twitter:image"]', 'content', `${window.location.origin}/logo.png`);

    let canonical = document.head.querySelector('link[rel="canonical"]');
    if (routeSeo.indexable && routeSeo.url) {
      if (!canonical) {
        canonical = document.createElement('link');
        canonical.rel = 'canonical';
        document.head.appendChild(canonical);
      }
      canonical.href = routeSeo.url;
    } else {
      canonical?.remove();
    }

    let structuredData = document.head.querySelector('#seo-structured-data');
    const structuredPayload = buildStructuredData(portal, pathname);
    if (structuredPayload) {
      if (!structuredData) {
        structuredData = document.createElement('script');
        structuredData.id = 'seo-structured-data';
        structuredData.type = 'application/ld+json';
        document.head.appendChild(structuredData);
      }
      structuredData.textContent = JSON.stringify(structuredPayload);
    } else {
      structuredData?.remove();
    }
  }, [pathname, portal, profile?.isTeacher, profile?.role]);

  return null;
};
