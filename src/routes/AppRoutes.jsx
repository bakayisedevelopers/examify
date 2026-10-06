import { Navigate, Route, Routes } from 'react-router-dom';
import { MarketingLayout } from '../layouts/MarketingLayout';
import { ProtectedRoute } from '../components/common/ProtectedRoute';
import { PortalHomePage } from '../pages/PortalHomePage';
import { LoginPage } from '../pages/auth/LoginPage';
import { SignupPage } from '../pages/auth/SignupPage';
import { StudentDashboardPage } from '../pages/student/StudentDashboardPage';
import { StudentExercisesPage } from '../pages/student/StudentExercisesPage';
import { StudentLessonsPage } from '../pages/student/StudentLessonsPage';
import { StudentLessonDetailsPage } from '../pages/student/StudentLessonDetailsPage';
import { StudentExerciseDetailsPage } from '../pages/student/StudentExerciseDetailsPage';
import { StudentPeerReviewsPage } from '../pages/student/StudentPeerReviewsPage';
import { StudentBillingPage } from '../pages/student/StudentBillingPage';
import { StudentProfilePage } from '../pages/student/StudentProfilePage';
import { TutorDashboardPage } from '../pages/tutor/TutorDashboardPage';
import { TutorStudentsPage } from '../pages/tutor/TutorStudentsPage';
import { TutorReportsPage } from '../pages/tutor/TutorReportsPage';
import { TutorStudentDetailsPage } from '../pages/tutor/TutorStudentDetailsPage';
import { TutorExercisesPage } from '../pages/tutor/TutorExercisesPage';
import { TutorExerciseDetailsPage } from '../pages/tutor/TutorExerciseDetailsPage';
import { TutorLessonsPage } from '../pages/tutor/TutorLessonsPage';
import { TutorLessonDetailsPage } from '../pages/tutor/TutorLessonDetailsPage';
import { AdminDashboardPage } from '../pages/admin/AdminDashboardPage';
import { AdminUsersPage } from '../pages/admin/AdminUsersPage';
import { AdminPaymentsPage } from '../pages/admin/AdminPaymentsPage';
import { AdminSettingsPage } from '../pages/admin/AdminSettingsPage';
import { AdminDiscountCodesPage } from '../pages/admin/AdminDiscountCodesPage';
import { PastExamPapersPage } from '../pages/PastExamPapersPage';
import { GuidePage } from '../pages/GuidePage';
import { ROLES } from '../lib/constants';
import { PoliciesPage } from '../pages/PoliciesPage';
import { ParentDashboardPage } from '../pages/parent/ParentDashboardPage';
import { ProfileHubPage } from '../pages/profile/ProfileHubPage';
import { ProfilePersonalDetailsPage } from '../pages/profile/ProfilePersonalDetailsPage';
import { ProfileSubjectsPage } from '../pages/profile/ProfileSubjectsPage';
import { ProfileBillingPage } from '../pages/profile/ProfileBillingPage';
import { ProfileLegalPage } from '../pages/profile/ProfileLegalPage';
import { ProfileSettingsPage } from '../pages/profile/ProfileSettingsPage';
import { TutorAgreementPage } from '../pages/profile/TutorAgreementPage';
import { PaperReaderPage } from '../pages/PaperReaderPage';
import { PaidStudentRoute } from '../components/common/PaidStudentRoute';

export const AppRoutes = () => (
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
);
