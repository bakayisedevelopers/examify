import { getPortalSiteUrl } from '../utils/portal.js';

export const PORTAL_SEO = {
  student: {
    title: 'Examifying | Online Maths Practice and Exam Preparation',
    description: 'Build confidence in Mathematics with focused daily exercises, handwritten work submissions, peer marking, and tutor guidance on Examifying.',
    keywords: 'online maths practice, mathematics exam preparation, daily maths exercises, maths tutor, Examifying',
  },
  tutor: {
    title: 'Examifying for Maths Tutors | Student Progress and Lessons',
    description: 'Support Maths learners with connected student progress, exercise submissions, topic understanding, and lesson tools in the Examifying tutor portal.',
    keywords: 'maths tutor platform, tutor student progress, mathematics lessons, student exercise review, Examifying tutor',
  },
  teacher: {
    title: 'Examifying for Maths Teachers | Learner Progress and Practice',
    description: 'Support Mathematics learners with a connected workspace for student progress, daily practice, exercise submissions, and lessons.',
    keywords: 'maths teacher platform, mathematics learner progress, daily maths practice, teacher lesson tools, Examifying teacher',
  },
  parent: {
    title: 'Examifying for Parents | Follow Maths Learning Progress',
    description: 'Stay connected to your child’s Mathematics learning with the Examifying parent portal and the progress information available to your family.',
    keywords: 'parent maths progress portal, child mathematics learning, Examifying parent portal',
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
