import { getPortalSiteUrl } from '../utils/portal.js';

export const PORTAL_SEO = {
  student: {
    title: 'Examifying | Online Maths Practice in South Africa',
    description: 'Examifying helps South African students build Mathematics confidence with daily practice, past-paper questions, peer marking, and tutor guidance.',
    keywords: 'Maths tutor South Africa, online maths tutor, maths tutor for students, online maths practice, South African maths exam preparation, daily Mathematics exercises, maths past papers, peer marking, Examifying',
  },
  tutor: {
    title: 'Examifying | Online Maths Tutor Platform in South Africa',
    description: 'An online Maths tutor workspace to manage connected students, review exercise submissions, track topic understanding, and link lessons with daily practice.',
    keywords: 'online maths tutor platform, Maths tutor portal, tutoring students online, tutor student management, maths lesson tracking, tutor exercise review, manage tutoring students online, Examifying tutor',
  },
  teacher: {
    title: 'Examifying | Maths Teacher Tools and Learner Progress',
    description: 'A Maths teacher portal for tracking learner progress, reviewing exercise submissions, following topic understanding, and connecting lessons with daily practice.',
    keywords: 'online maths teacher tools, South African maths teacher portal, Mathematics learner progress, maths lesson management, daily maths practice for learners, teacher exercise review, Examifying teacher',
  },
  parent: {
    title: 'Examifying | Parent Maths Progress Portal in South Africa',
    description: 'Follow your child’s Maths learning with a parent portal for linked learners, available exercise activity, and progress information from Examifying.',
    keywords: 'parent maths portal, child maths progress, maths learning for children, online maths practice for school students, South African Mathematics exam support, parent dashboard, tutor-supported maths learning, Examifying parent portal',
  },
  admin: {
    title: 'Examifying Administration Portal',
    description: 'Secure sign-in for authorised Examifying platform administrators.',
    keywords: 'Examifying administration portal',
  },
};

const PAGE_DESCRIPTIONS = {
  login: 'Sign in to your Examifying account to continue to your role-specific Mathematics learning workspace.',
  signup: 'Create an Examifying account and choose the role-specific Mathematics learning portal that is right for you.',
  policies: 'Read Examifying terms of use, privacy information, refund policy, and contact details.',
  dashboard: 'View your Examifying dashboard and the learning information available to your account.',
  exercises: 'View daily Mathematics exercises and related learning activity in Examifying.',
  lessons: 'View Mathematics lessons and learning activities in Examifying.',
  papers: 'Explore Mathematics past exam papers available in Examifying.',
  students: 'Manage connected learners and review the student information available to your account.',
  profile: 'View your Examifying account profile and preferences.',
};

const getSiteOrigin = (portal) => getPortalSiteUrl(portal).replace(/\/$/, '');

export const getRouteSeo = (pathname, portal) => {
  const portalSeo = PORTAL_SEO[portal] || PORTAL_SEO.student;

  if (pathname === '/') {
    return {
      ...portalSeo,
      url: `${getSiteOrigin(portal)}/`,
      robots: portal === 'admin' ? 'noindex,nofollow' : 'index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1',
      indexable: portal !== 'admin',
    };
  }

  if (pathname === '/policies') {
    return {
      title: 'Policies | Examifying',
      description: PAGE_DESCRIPTIONS.policies,
      keywords: 'Examifying terms, privacy policy, refund policy, contact',
      url: `${getSiteOrigin(portal)}/policies`,
      robots: 'index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1',
      indexable: true,
    };
  }

  if (pathname === '/login' || pathname === '/signup') {
    const isLogin = pathname === '/login';
    return {
      title: `${isLogin ? 'Sign in' : 'Create an account'} | ${portalSeo.title.split('|')[0].trim()}`,
      description: PAGE_DESCRIPTIONS[isLogin ? 'login' : 'signup'],
      keywords: portalSeo.keywords,
      robots: 'noindex,nofollow',
      indexable: false,
    };
  }

  const pageSegment = pathname.split('/').filter(Boolean)[1];
  const section = pageSegment === 'profile'
    ? 'profile'
    : ['exercises', 'lessons', 'papers', 'students'].includes(pageSegment)
      ? pageSegment
      : 'dashboard';

  return {
    title: `${portal[0].toUpperCase()}${portal.slice(1)} | ${section === 'dashboard' ? 'Workspace' : section[0].toUpperCase() + section.slice(1)}`,
    description: PAGE_DESCRIPTIONS[section],
    keywords: portalSeo.keywords,
    robots: 'noindex,nofollow',
    indexable: false,
  };
};

export const buildStructuredData = (portal, pathname = '/') => {
  const routeSeo = getRouteSeo(pathname, portal);
  if (!routeSeo.indexable) return null;

  const origin = getSiteOrigin(portal);
  const organizationId = `${origin}/#organization`;
  const websiteId = `${origin}/#website`;
  const pageUrl = routeSeo.url;

  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'EducationalOrganization',
        '@id': organizationId,
        name: 'Examifying',
        url: `${origin}/`,
        logo: {
          '@type': 'ImageObject',
          url: `${origin}/logo.png`,
        },
        description: PORTAL_SEO[portal]?.description || PORTAL_SEO.student.description,
      },
      {
        '@type': 'WebSite',
        '@id': websiteId,
        name: 'Examifying',
        url: `${origin}/`,
        publisher: { '@id': organizationId },
        inLanguage: 'en-ZA',
      },
      {
        '@type': 'WebPage',
        '@id': `${pageUrl}#webpage`,
        url: pageUrl,
        name: routeSeo.title,
        description: routeSeo.description,
        isPartOf: { '@id': websiteId },
        about: { '@id': organizationId },
        inLanguage: 'en-ZA',
      },
      ...(pathname === '/' && portal !== 'admin'
        ? [{
          '@type': 'SoftwareApplication',
          name: 'Examifying',
          applicationCategory: 'EducationalApplication',
          operatingSystem: 'Web',
          url: `${origin}/`,
          description: PORTAL_SEO[portal]?.description || PORTAL_SEO.student.description,
        }]
        : []),
    ],
  };
};
