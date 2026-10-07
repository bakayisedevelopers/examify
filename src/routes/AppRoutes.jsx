import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { MarketingLayout } from '../layouts/MarketingLayout';
import { ProtectedRoute } from '../components/common/ProtectedRoute';
import { ROLES } from '../lib/constants';
import { PaidStudentRoute } from '../components/common/PaidStudentRoute';

const lazyNamed = (loader, exportName) => lazy(() => loader().then((module) => ({ default: module[exportName] })));

const PortalHomePage = lazyNamed(() => import('../pages/PortalHomePage'), 'PortalHomePage');
const LoginPage = lazyNamed(() => import('../pages/auth/LoginPage'), 'LoginPage');
const SignupPage = lazyNamed(() => import('../pages/auth/SignupPage'), 'SignupPage');
const StudentDashboardPage = lazyNamed(() => import('../pages/student/StudentDashboardPage'), 'StudentDashboardPage');
const StudentExercisesPage = lazyNamed(() => import('../pages/student/StudentExercisesPage'), 'StudentExercisesPage');
const StudentLessonsPage = lazyNamed(() => import('../pages/student/StudentLessonsPage'), 'StudentLessonsPage');
const StudentLessonDetailsPage = lazyNamed(() => import('../pages/student/StudentLessonDetailsPage'), 'StudentLessonDetailsPage');
const StudentExerciseDetailsPage = lazyNamed(() => import('../pages/student/StudentExerciseDetailsPage'), 'StudentExerciseDetailsPage');
const StudentPeerReviewsPage = lazyNamed(() => import('../pages/student/StudentPeerReviewsPage'), 'StudentPeerReviewsPage');
const StudentBillingPage = lazyNamed(() => import('../pages/student/StudentBillingPage'), 'StudentBillingPage');
const StudentProfilePage = lazyNamed(() => import('../pages/student/StudentProfilePage'), 'StudentProfilePage');
const TutorDashboardPage = lazyNamed(() => import('../pages/tutor/TutorDashboardPage'), 'TutorDashboardPage');
const TutorStudentsPage = lazyNamed(() => import('../pages/tutor/TutorStudentsPage'), 'TutorStudentsPage');
const TutorReportsPage = lazyNamed(() => import('../pages/tutor/TutorReportsPage'), 'TutorReportsPage');
const TutorStudentDetailsPage = lazyNamed(() => import('../pages/tutor/TutorStudentDetailsPage'), 'TutorStudentDetailsPage');
const TutorExercisesPage = lazyNamed(() => import('../pages/tutor/TutorExercisesPage'), 'TutorExercisesPage');
const TutorExerciseDetailsPage = lazyNamed(() => import('../pages/tutor/TutorExerciseDetailsPage'), 'TutorExerciseDetailsPage');
const TutorLessonsPage = lazyNamed(() => import('../pages/tutor/TutorLessonsPage'), 'TutorLessonsPage');
const TutorLessonDetailsPage = lazyNamed(() => import('../pages/tutor/TutorLessonDetailsPage'), 'TutorLessonDetailsPage');
const AdminDashboardPage = lazyNamed(() => import('../pages/admin/AdminDashboardPage'), 'AdminDashboardPage');
const AdminUsersPage = lazyNamed(() => import('../pages/admin/AdminUsersPage'), 'AdminUsersPage');
const AdminUserDetailsPage = lazyNamed(() => import('../pages/admin/AdminUserDetailsPage'), 'AdminUserDetailsPage');
const AdminPaymentsPage = lazyNamed(() => import('../pages/admin/AdminPaymentsPage'), 'AdminPaymentsPage');
const AdminSettingsPage = lazyNamed(() => import('../pages/admin/AdminSettingsPage'), 'AdminSettingsPage');
const AdminDiscountCodesPage = lazyNamed(() => import('../pages/admin/AdminDiscountCodesPage'), 'AdminDiscountCodesPage');
const PastExamPapersPage = lazyNamed(() => import('../pages/PastExamPapersPage'), 'PastExamPapersPage');
const GuidePage = lazyNamed(() => import('../pages/GuidePage'), 'GuidePage');
const PoliciesPage = lazyNamed(() => import('../pages/PoliciesPage'), 'PoliciesPage');
const ParentDashboardPage = lazyNamed(() => import('../pages/parent/ParentDashboardPage'), 'ParentDashboardPage');
const ProfileHubPage = lazyNamed(() => import('../pages/profile/ProfileHubPage'), 'ProfileHubPage');
const ProfilePersonalDetailsPage = lazyNamed(() => import('../pages/profile/ProfilePersonalDetailsPage'), 'ProfilePersonalDetailsPage');
const ProfileSubjectsPage = lazyNamed(() => import('../pages/profile/ProfileSubjectsPage'), 'ProfileSubjectsPage');
const ProfileBillingPage = lazyNamed(() => import('../pages/profile/ProfileBillingPage'), 'ProfileBillingPage');
const ProfileLegalPage = lazyNamed(() => import('../pages/profile/ProfileLegalPage'), 'ProfileLegalPage');
const ProfileSettingsPage = lazyNamed(() => import('../pages/profile/ProfileSettingsPage'), 'ProfileSettingsPage');
const TutorAgreementPage = lazyNamed(() => import('../pages/profile/TutorAgreementPage'), 'TutorAgreementPage');
const PaperReaderPage = lazyNamed(() => import('../pages/PaperReaderPage'), 'PaperReaderPage');

export const AppRoutes = () => (
  <Suspense fallback={<div className="flex min-h-screen items-center justify-center text-sm text-slate-500" role="status">Loading page…</div>}>
    <Routes>
    <Route element={<MarketingLayout />}>
      <Route path="/" element={<PortalHomePage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/policies" element={<PoliciesPage />} />
    </Route>

    <Route element={<ProtectedRoute allowedRoles={[ROLES.STUDENT]} />}>
      <Route path="/student" element={<StudentDashboardPage />} />
      <Route path="/student/billing" element={<StudentBillingPage />} />
      <Route path="/student/profile" element={<ProfileHubPage role={ROLES.STUDENT} />} />
      <Route path="/student/profile/details" element={<ProfilePersonalDetailsPage role={ROLES.STUDENT} />} />
      <Route path="/student/profile/legal" element={<ProfileLegalPage role={ROLES.STUDENT} />} />
      <Route path="/student/profile/settings" element={<ProfileSettingsPage role={ROLES.STUDENT} />} />
      <Route path="/student/profile/legacy" element={<StudentProfilePage />} />
      <Route path="/student/papers" element={<PastExamPapersPage />} />
      <Route path="/student/papers/:paperId" element={<PaperReaderPage />} />
      <Route element={<PaidStudentRoute />}>
        <Route path="/student/exercises" element={<StudentExercisesPage />} />
        <Route path="/student/exercises/:exerciseId" element={<StudentExerciseDetailsPage />} />
        <Route path="/student/lessons" element={<StudentLessonsPage />} />
        <Route path="/student/lessons/:lessonId" element={<StudentLessonDetailsPage />} />
        <Route path="/student/peer-reviews" element={<StudentPeerReviewsPage />} />
        <Route path="/student/guide" element={<GuidePage role="student" />} />
        <Route path="/student/profile/subjects" element={<ProfileSubjectsPage role={ROLES.STUDENT} />} />
      </Route>
      <Route path="/policies" element={<PoliciesPage />} />
    </Route>

    <Route element={<ProtectedRoute allowedRoles={[ROLES.PARENT]} />}>
      <Route path="/parent" element={<ParentDashboardPage />} />
      <Route path="/parent/profile" element={<ProfileHubPage role={ROLES.PARENT} />} />
      <Route path="/parent/profile/details" element={<ProfilePersonalDetailsPage role={ROLES.PARENT} />} />
      <Route path="/parent/profile/subjects" element={<ProfileSubjectsPage role={ROLES.PARENT} />} />
      <Route path="/parent/profile/billing" element={<ProfileBillingPage role={ROLES.PARENT} />} />
      <Route path="/parent/profile/legal" element={<ProfileLegalPage role={ROLES.PARENT} />} />
      <Route path="/parent/profile/settings" element={<ProfileSettingsPage role={ROLES.PARENT} />} />
      <Route path="/policies" element={<PoliciesPage />} />
    </Route>

    <Route element={<ProtectedRoute allowedRoles={[ROLES.TUTOR]} />}>
      <Route path="/tutor" element={<TutorDashboardPage />} />
      <Route path="/tutor/students" element={<TutorStudentsPage />} />
      <Route path="/tutor/students/:studentId" element={<TutorStudentDetailsPage />} />
      <Route path="/tutor/exercises" element={<TutorExercisesPage />} />
      <Route path="/tutor/exercises/:exerciseId" element={<TutorExerciseDetailsPage />} />
      <Route path="/tutor/lessons" element={<TutorLessonsPage />} />
      <Route path="/tutor/lessons/:lessonId" element={<TutorLessonDetailsPage />} />
      <Route path="/tutor/papers" element={<PastExamPapersPage />} />
      <Route path="/tutor/papers/:paperId" element={<PaperReaderPage />} />
      <Route path="/tutor/reports" element={<TutorReportsPage />} />
      <Route path="/tutor/guide" element={<GuidePage role="tutor" />} />
      <Route path="/tutor/profile" element={<ProfileHubPage role={ROLES.TUTOR} />} />
      <Route path="/tutor/profile/details" element={<ProfilePersonalDetailsPage role={ROLES.TUTOR} />} />
      <Route path="/tutor/profile/subjects" element={<ProfileSubjectsPage role={ROLES.TUTOR} />} />
      <Route path="/tutor/profile/billing" element={<ProfileBillingPage role={ROLES.TUTOR} />} />
      <Route path="/tutor/profile/legal" element={<ProfileLegalPage role={ROLES.TUTOR} />} />
      <Route path="/tutor/profile/settings" element={<ProfileSettingsPage role={ROLES.TUTOR} />} />
      <Route path="/tutor/profile/agreement" element={<TutorAgreementPage />} />
      <Route path="/policies" element={<PoliciesPage />} />
    </Route>

    <Route element={<ProtectedRoute allowedRoles={[ROLES.TUTOR]} />}>
      <Route path="/teacher" element={<TutorDashboardPage />} />
      <Route path="/teacher/students" element={<TutorStudentsPage />} />
      <Route path="/teacher/students/:studentId" element={<TutorStudentDetailsPage />} />
      <Route path="/teacher/exercises" element={<TutorExercisesPage />} />
      <Route path="/teacher/exercises/:exerciseId" element={<TutorExerciseDetailsPage />} />
      <Route path="/teacher/lessons" element={<TutorLessonsPage />} />
      <Route path="/teacher/lessons/:lessonId" element={<TutorLessonDetailsPage />} />
      <Route path="/teacher/papers" element={<PastExamPapersPage />} />
      <Route path="/teacher/papers/:paperId" element={<PaperReaderPage />} />
      <Route path="/teacher/reports" element={<TutorReportsPage />} />
      <Route path="/teacher/guide" element={<GuidePage role="teacher" />} />
      <Route path="/teacher/profile" element={<ProfileHubPage role="teacher" />} />
      <Route path="/teacher/profile/details" element={<ProfilePersonalDetailsPage role="teacher" />} />
      <Route path="/teacher/profile/subjects" element={<ProfileSubjectsPage role="teacher" />} />
      <Route path="/teacher/profile/billing" element={<ProfileBillingPage role="teacher" />} />
      <Route path="/teacher/profile/legal" element={<ProfileLegalPage role="teacher" />} />
      <Route path="/teacher/profile/settings" element={<ProfileSettingsPage role="teacher" />} />
      <Route path="/teacher/profile/agreement" element={<TutorAgreementPage role="teacher" />} />
    </Route>

    <Route element={<ProtectedRoute allowedRoles={[ROLES.ADMIN]} />}>
      <Route path="/admin" element={<AdminDashboardPage />} />
      <Route path="/admin/users/:userId" element={<AdminUserDetailsPage />} />
      <Route path="/admin/users" element={<AdminUsersPage />} />
      <Route path="/admin/payments" element={<AdminPaymentsPage />} />
      <Route path="/admin/discount-codes" element={<AdminDiscountCodesPage />} />
      <Route path="/admin/settings" element={<AdminSettingsPage />} />
      <Route path="/admin/papers" element={<PastExamPapersPage />} />
      <Route path="/admin/papers/:paperId" element={<PaperReaderPage />} />
      <Route path="/admin/profile" element={<ProfileHubPage role={ROLES.ADMIN} />} />
      <Route path="/admin/profile/details" element={<ProfilePersonalDetailsPage role={ROLES.ADMIN} />} />
      <Route path="/admin/profile/subjects" element={<ProfileSubjectsPage role={ROLES.ADMIN} />} />
      <Route path="/admin/profile/billing" element={<ProfileBillingPage role={ROLES.ADMIN} />} />
      <Route path="/admin/profile/legal" element={<ProfileLegalPage role={ROLES.ADMIN} />} />
      <Route path="/admin/profile/settings" element={<ProfileSettingsPage role={ROLES.ADMIN} />} />
      <Route path="/policies" element={<PoliciesPage />} />
    </Route>

    <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  </Suspense>
);
