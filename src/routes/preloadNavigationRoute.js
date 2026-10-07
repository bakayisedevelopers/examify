const routeImports = {
  '/tutor': () => import('../pages/tutor/TutorDashboardPage'),
  '/tutor/exercises': () => import('../pages/tutor/TutorExercisesPage'),
  '/tutor/lessons': () => import('../pages/tutor/TutorLessonsPage'),
  '/tutor/papers': () => import('../pages/PastExamPapersPage'),
  '/tutor/reports': () => import('../pages/tutor/TutorReportsPage'),
  '/tutor/guide': () => import('../pages/GuidePage'),
  '/tutor/profile': () => import('../pages/profile/ProfileHubPage'),
  '/teacher': () => import('../pages/tutor/TutorDashboardPage'),
  '/teacher/exercises': () => import('../pages/tutor/TutorExercisesPage'),
  '/teacher/lessons': () => import('../pages/tutor/TutorLessonsPage'),
  '/teacher/papers': () => import('../pages/PastExamPapersPage'),
  '/teacher/reports': () => import('../pages/tutor/TutorReportsPage'),
  '/teacher/guide': () => import('../pages/GuidePage'),
  '/teacher/profile': () => import('../pages/profile/ProfileHubPage'),
};

const dynamicRouteImports = [
  {
    matches: (path) => /^\/(tutor|teacher)\/students\/[^/]+$/.test(path),
    key: 'student-detail',
    load: () => import('../pages/tutor/TutorStudentDetailsPage'),
  },
  {
    matches: (path) => /^\/(tutor|teacher)\/exercises\/[^/]+$/.test(path),
    key: 'exercise-detail',
    load: () => import('../pages/tutor/TutorExerciseDetailsPage'),
  },
  {
    matches: (path) => /^\/(tutor|teacher)\/lessons\/[^/]+$/.test(path),
    key: 'lesson-detail',
    load: () => import('../pages/tutor/TutorLessonDetailsPage'),
  },
];

const preloadPromises = new Map();

export const preloadNavigationRoute = (path) => {
  const routePath = path.split('?')[0];
  const dynamicRoute = dynamicRouteImports.find((route) => route.matches(routePath));
  const cacheKey = dynamicRoute?.key ?? routePath;
  const importRoute = dynamicRoute?.load ?? routeImports[routePath];
  if (!importRoute) return Promise.resolve();

  if (!preloadPromises.has(cacheKey)) {
    const promise = importRoute().catch((error) => {
      preloadPromises.delete(cacheKey);
      throw error;
    });
    preloadPromises.set(cacheKey, promise);
  }

  return preloadPromises.get(cacheKey);
};

export const warmNavigationRoute = (path) => {
  void preloadNavigationRoute(path).catch(() => {});
};
