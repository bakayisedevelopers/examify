import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  BadgeCheck,
  BookOpen,
  CalendarDays,
  CircleAlert,
  ExternalLink,
  FileText,
  GraduationCap,
  Mail,
  MapPin,
  Phone,
  Plus,
  RefreshCw,
  School,
  ShieldCheck,
  UserRound,
  Users,
} from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { LoadingState } from '../../components/common/LoadingState';
import { SectionHeader } from '../../components/common/SectionHeader';
import { useAuth } from '../../hooks/useAuth';
import { useOperationStatus } from '../../hooks/useOperationStatus';
import { useScreenLoadMetrics } from '../../hooks/useScreenLoadMetrics';
import { SUBJECTS } from '../../lib/constants';
import { addAdminTutorSubject, getAdminUserDetails, getStudentSubscriptionState, getTutorMarksDocuments } from '../../services/firestoreService';

const roleLabel = (role = 'unknown') => String(role).replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
const dateValue = (value) => {
  if (!value) return null;
  if (value?.toDate) return value.toDate();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
};
const formatDate = (value) => {
  const date = dateValue(value);
  return date ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date) : '';
};
const statusLabel = (value = '') => String(value).replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
const isHistorical = (status) => ['cancelled', 'canceled', 'archived', 'removed', 'inactive', 'historical'].includes(String(status || '').toLowerCase());

const ProfileField = ({ icon: Icon, label, value }) => value ? (
  <div className="flex min-w-0 gap-3 rounded-xl border border-slate-800 bg-slate-950/70 p-3">
    <Icon className="mt-0.5 h-4 w-4 shrink-0 text-lime-300" aria-hidden="true" />
    <div className="min-w-0">
      <p className="text-xs font-medium text-slate-400">{label}</p>
      <p className="mt-1 break-words text-sm font-semibold text-slate-100">{value}</p>
    </div>
  </div>
) : null;

const StatusBadge = ({ status, label }) => {
  const normalized = String(status || '').toLowerCase();
  const style = ['active', 'approved', 'done', 'completed', 'success'].includes(normalized)
    ? 'border-lime-300/60 bg-lime-100 text-lime-950'
    : ['past_due', 'pending', 'processing'].includes(normalized)
      ? 'border-amber-300/50 bg-amber-100 text-amber-950'
      : ['cancelled', 'canceled', 'failed', 'disabled'].includes(normalized)
        ? 'border-rose-300/50 bg-rose-100 text-rose-950'
        : 'border-slate-600 bg-slate-800 text-slate-100';
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${style}`}>{label || statusLabel(status || 'Not available')}</span>;
};

const SectionCard = ({ eyebrow, title, description, icon: Icon, children, action }) => (
  <section className="panel space-y-4 p-5 sm:p-6">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex gap-3">
        {Icon ? <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-lime-300/25 bg-lime-300/10 text-lime-300"><Icon className="h-5 w-5" aria-hidden="true" /></span> : null}
        <SectionHeader eyebrow={eyebrow} title={title} description={description} />
      </div>
      {action}
    </div>
    {children}
  </section>
);

export const AdminUserDetailsPage = () => {
  const { userId = '' } = useParams();
  const { profile, logout } = useAuth();
  const { runOperation } = useOperationStatus();
  const [details, setDetails] = useState(null);
  const [subscription, setSubscription] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tutorDocuments, setTutorDocuments] = useState([]);
  const [tutorDocumentsLoading, setTutorDocumentsLoading] = useState(false);
  const [tutorDocumentsError, setTutorDocumentsError] = useState('');
  const [error, setError] = useState('');
  const [subscriptionError, setSubscriptionError] = useState('');
  const [selectedSubject, setSelectedSubject] = useState('');
  const [mark, setMark] = useState('');
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState('');
  const [savingSubject, setSavingSubject] = useState(false);
  const user = details?.profile;
  const isTutor = user?.role === 'tutor' || user?.role === 'teacher';
  const loadTutorDocuments = useCallback(async (tutorId = user?.uid) => {
    if (!tutorId) return;
    setTutorDocumentsLoading(true);
    setTutorDocumentsError('');
    try {
      setTutorDocuments(await getTutorMarksDocuments(tutorId));
    } catch (documentsLoadError) {
      setTutorDocuments([]);
      setTutorDocumentsError(documentsLoadError.message || 'Uploaded results could not be loaded.');
    } finally {
      setTutorDocumentsLoading(false);
    }
  }, [user?.uid]);
  const markedSubjects = useMemo(() => new Set((details?.tutor?.subjects ?? [])
    .filter((item) => item.mark !== null && item.mark !== undefined)
    .map((item) => item.subject)), [details?.tutor?.subjects]);
  const availableSubjects = useMemo(() => SUBJECTS.filter((subject) => !markedSubjects.has(subject)), [markedSubjects]);

  const loadDetails = async () => {
    setLoading(true);
    setError('');
    setSubscriptionError('');
    try {
      const result = await getAdminUserDetails(userId);
      setDetails(result);
      if (result.profile.role === 'student') {
        try {
          const state = await getStudentSubscriptionState({ uid: userId });
          setSubscription({
            planName: state.subscriptionPlanName || 'Free',
            status: state.subscriptionStatus || (state.paymentCompleted ? 'active' : 'plan_required'),
            renewalDate: state.subscriptionRenewalDate || null,
            paymentCompleted: state.paymentCompleted === true,
          });
        } catch (subscriptionLoadError) {
          setSubscription(null);
          setSubscriptionError(subscriptionLoadError.message || 'Subscription information could not be loaded.');
        }
      } else {
        setSubscription(null);
      }
    } catch (loadError) {
      setError(loadError.message || 'Could not load this user profile.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDetails();
    // Loading is intentionally keyed to the selected route ID.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  useEffect(() => {
    if (!isTutor || !user?.uid || user.uid !== userId) {
      setTutorDocuments([]);
      setTutorDocumentsError('');
      setTutorDocumentsLoading(false);
      return;
    }
    loadTutorDocuments(user.uid);
  }, [isTutor, loadTutorDocuments, user?.uid, userId]);

  useEffect(() => {
    if (!availableSubjects.length) {
      setSelectedSubject('');
      return;
    }
    if (!availableSubjects.includes(selectedSubject)) setSelectedSubject(availableSubjects[0]);
  }, [availableSubjects, selectedSubject]);

  useScreenLoadMetrics('Admin user details', 'admin', !loading && !error);

  const handleAddSubject = async (event) => {
    event.preventDefault();
    if (!user?.uid || !selectedSubject || savingSubject) return;
    setSavingSubject(true);
    setMessage('');
    setMessageType('');
    try {
      await runOperation({ operationName: 'Adding tutor subject', successMessage: 'The subject and mark were saved.' }, async () => {
        await addAdminTutorSubject({ tutorId: user.uid, subject: selectedSubject, mark });
        const refreshed = await getAdminUserDetails(user.uid);
        setDetails(refreshed);
        setMark('');
      });
      setMessage(`${selectedSubject} was added with a mark of ${Number(mark)}%.`);
      setMessageType('success');
    } catch (saveError) {
      setMessage(saveError.message || 'Could not add this subject.');
      setMessageType('error');
    } finally {
      setSavingSubject(false);
    }
  };

  return (
    <AppShell title="User details" subtitle="Review role-specific account information." role="admin" user={profile} onLogout={logout}>
      <div className="space-y-5">
        <Link to="/admin/users" className="btn-secondary w-fit"><ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />All users</Link>

        {loading ? <LoadingState label="Loading user details…" /> : null}
        {!loading && error ? (
          <div className="panel space-y-4 p-5" role="alert">
            <div className="flex items-start gap-3 text-rose-200"><CircleAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" /><p className="text-sm">{error}</p></div>
            <button type="button" className="btn-secondary" onClick={loadDetails}>Try again</button>
          </div>
        ) : null}

        {!loading && !error && user ? <>
          <section className="panel flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
            <div className="flex min-w-0 items-center gap-4">
              <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-lime-300/30 bg-gradient-to-br from-lime-300/20 to-emerald-400/10 text-lime-200"><UserRound className="h-7 w-7" aria-hidden="true" /></span>
              <div className="min-w-0">
                <h2 className="truncate text-xl font-bold text-white sm:text-2xl">{user.name || 'Name unavailable'}</h2>
                <p className="mt-1 truncate text-sm text-slate-400">{user.email || 'No email address recorded'}</p>
              </div>
            </div>
            <span className="inline-flex w-fit items-center gap-2 rounded-full border border-lime-300/60 bg-lime-100 px-3 py-1.5 text-sm font-bold text-lime-950"><BadgeCheck className="h-4 w-4" aria-hidden="true" />{roleLabel(user.role)}</span>
          </section>

          <SectionCard eyebrow="Account" title="Profile" description="Verified account details currently stored for this user." icon={UserRound}>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <ProfileField icon={Mail} label="Email" value={user.email} />
              <ProfileField icon={Phone} label="Phone / WhatsApp" value={user.phone} />
              <ProfileField icon={ShieldCheck} label="Account status" value={user.accountStatus ? <StatusBadge status={user.accountStatus} /> : ''} />
              <ProfileField icon={CalendarDays} label="Joined" value={formatDate(user.createdAt)} />
              <ProfileField icon={CalendarDays} label="Last active" value={formatDate(user.lastLoginAt)} />
              <ProfileField icon={GraduationCap} label="Grade / education" value={user.grade || user.educationLevel} />
              <ProfileField icon={School} label="School" value={user.school} />
              <ProfileField icon={MapPin} label="Province" value={user.province} />
            </div>
            {!user.email && !user.phone && !user.accountStatus && !user.createdAt && !user.lastLoginAt && !user.grade && !user.educationLevel && !user.school && !user.province ? (
              <p className="text-sm text-slate-400">No additional profile fields are available for this account.</p>
            ) : null}
          </SectionCard>

          {user.role === 'student' ? <>
            <SectionCard eyebrow="Plan" title="Subscription" description="Current verified plan status and renewal date, if available." icon={ShieldCheck}>
              {subscriptionError ? <p className="rounded-xl border border-amber-300/30 bg-amber-200/10 p-3 text-sm text-amber-100" role="status">{subscriptionError}</p> : null}
              {subscription ? <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4"><p className="text-xs text-slate-400">Current plan</p><p className="mt-2 text-lg font-bold text-white">{subscription.planName}</p></div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4"><p className="text-xs text-slate-400">Status</p><div className="mt-2"><StatusBadge status={subscription.status} /></div></div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4"><p className="text-xs text-slate-400">Renewal date</p><p className="mt-2 text-sm font-semibold text-white">{formatDate(subscription.renewalDate) || 'Not scheduled'}</p></div>
              </div> : null}
            </SectionCard>

            <SectionCard eyebrow="Learning" title="Subjects" description="Active subject episodes and preserved historical subjects." icon={BookOpen}>
              {details.student?.subjects?.length ? <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {details.student.subjects.map((subject) => (
                  <article key={subject.id} className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <h3 className="font-semibold text-white">{subject.subject}</h3>
                      <StatusBadge status={isHistorical(subject.status) ? 'historical' : subject.status} />
                    </div>
                    <p className="mt-2 text-sm text-slate-400">{subject.grade || user.grade || 'Grade not listed'}</p>
                    {isHistorical(subject.status) && subject.cancelledAt ? <p className="mt-2 text-xs text-slate-500">Ended {formatDate(subject.cancelledAt)}</p> : null}
                  </article>
                ))}
              </div> : <p className="rounded-xl border border-slate-800 bg-slate-950/70 p-4 text-sm text-slate-400">No subject episodes are available for this student.</p>}
            </SectionCard>
          </> : null}

          {isTutor ? <>
            <SectionCard eyebrow="Teaching" title="Subjects and marks" description="Existing tutor subject records and the marks used for subject approval." icon={GraduationCap}>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {(details.tutor?.subjects ?? []).map((item) => (
                  <article key={item.subject} className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <h3 className="font-semibold text-white">{item.subject}</h3>
                      <StatusBadge status={item.approved ? 'approved' : 'not approved'} />
                    </div>
                    <p className="mt-2 text-sm text-slate-300">Mark: <span className="font-semibold text-white">{item.mark === null ? 'Not recorded' : `${item.mark}%`}</span></p>
                  </article>
                ))}
                {!details.tutor?.subjects?.length ? <p className="rounded-xl border border-slate-800 bg-slate-950/70 p-4 text-sm text-slate-400">No subject records are available for this account.</p> : null}
              </div>

              <form onSubmit={handleAddSubject} className="grid gap-3 rounded-2xl border border-lime-300/20 bg-lime-300/5 p-4 sm:grid-cols-[minmax(0,1fr)_10rem_auto] sm:items-end">
                <label>
                  <span className="label">Subject</span>
                  <select className="input" value={selectedSubject} onChange={(event) => setSelectedSubject(event.target.value)} disabled={!availableSubjects.length || savingSubject} required>
                    {availableSubjects.length ? availableSubjects.map((subject) => <option key={subject} value={subject}>{subject}</option>) : <option value="">All subjects have marks</option>}
                  </select>
                </label>
                <label>
                  <span className="label">Mark (%)</span>
                  <input className="input" type="number" min="60" max="100" step="0.1" value={mark} onChange={(event) => setMark(event.target.value)} placeholder="60–100" required disabled={savingSubject} />
                </label>
                <button type="submit" className="btn-primary" disabled={!selectedSubject || !mark || savingSubject}>
                  <Plus className="mr-2 h-4 w-4" aria-hidden="true" />{savingSubject ? 'Saving…' : 'Add subject'}
                </button>
              </form>
              <p className="text-xs text-slate-400">Marks must be 60–100 because the existing approval logic requires at least 60. The saved mark is added to this tutor or teacher’s existing subject marks.</p>
              {message ? <p className={`text-sm ${messageType === 'error' ? 'text-rose-200' : 'text-lime-200'}`} role="status">{message}</p> : null}
            </SectionCard>

            <SectionCard eyebrow="Results review" title="Uploaded results documents" description="Open the tutor’s uploaded proof to review marks and see the extraction result." icon={FileText}>
              {tutorDocumentsError ? (
                <div className="flex flex-col gap-3 rounded-xl border border-rose-300/30 bg-rose-300/10 p-4 sm:flex-row sm:items-center sm:justify-between" role="alert">
                  <p className="text-sm text-rose-100">{tutorDocumentsError}</p>
                  <button type="button" className="btn-secondary shrink-0" onClick={() => loadTutorDocuments()} disabled={tutorDocumentsLoading}>
                    <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />Try again
                  </button>
                </div>
              ) : null}
              {tutorDocumentsLoading ? <LoadingState label="Loading uploaded results…" /> : null}
              {!tutorDocumentsLoading && !tutorDocumentsError && !tutorDocuments.length ? (
                <p className="rounded-xl border border-slate-800 bg-slate-950/70 p-4 text-sm text-slate-400">This tutor or teacher has not uploaded any results documents.</p>
              ) : null}
              {!tutorDocumentsLoading && tutorDocuments.length ? (
                <div className="space-y-3">
                  {tutorDocuments.map((documentRecord) => {
                    const status = String(documentRecord.status || 'processing').toLowerCase();
                    const statusText = status === 'done' ? 'Extraction passed' : status === 'failed' ? 'Extraction failed' : status === 'processing' ? 'Processing' : statusLabel(status);
                    return (
                      <article key={documentRecord.id} className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="flex min-w-0 items-start gap-3">
                            <FileText className="mt-0.5 h-5 w-5 shrink-0 text-lime-300" aria-hidden="true" />
                            <div className="min-w-0">
                              <h3 className="break-words font-semibold text-white">{documentRecord.fileName || 'Results document'}</h3>
                              <p className="mt-1 text-xs text-slate-400">Uploaded {formatDate(documentRecord.createdAt) || 'date unavailable'}</p>
                            </div>
                          </div>
                          <div className="flex shrink-0 flex-wrap items-center gap-2">
                            <StatusBadge status={status} label={statusText} />
                            {documentRecord.fileUrl ? (
                              <a href={documentRecord.fileUrl} target="_blank" rel="noopener noreferrer" className="btn-secondary inline-flex items-center px-3 py-2 text-sm">
                                <ExternalLink className="mr-2 h-4 w-4" aria-hidden="true" />Open document
                              </a>
                            ) : <span className="text-xs text-slate-500">File link unavailable</span>}
                          </div>
                        </div>
                        {documentRecord.progressMessage ? <p className="mt-3 text-sm text-slate-300">{documentRecord.progressMessage}</p> : null}
                        {documentRecord.errorMessage ? <p className="mt-3 rounded-lg border border-rose-300/20 bg-rose-300/10 p-3 text-sm text-rose-100">{documentRecord.errorMessage}</p> : null}
                        {documentRecord.extractedMarks?.length ? (
                          <div className="mt-3 flex flex-wrap gap-2" aria-label="Extracted marks">
                            {documentRecord.extractedMarks.map((item, index) => (
                              <span key={`${documentRecord.id}-${item.subject}-${item.mark}-${index}`} className="rounded-full border border-lime-300/20 bg-lime-300/10 px-3 py-1 text-xs font-medium text-lime-100">
                                {item.subject}: {item.mark}%
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              ) : null}
            </SectionCard>

            <SectionCard eyebrow="Access" title="Student assignments" description="Primary tutor assignments and existing shared or historical episode access." icon={Users}>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4"><p className="text-sm text-slate-400">Active primary assignments</p><p className="mt-1 text-2xl font-bold text-white">{details.tutor?.activePrimaryStudentCount ?? 0}</p></div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4"><p className="text-sm text-slate-400">Active shared access</p><p className="mt-1 text-2xl font-bold text-white">{details.tutor?.activeSharedStudentCount ?? 0}</p></div>
              </div>
              {details.tutor?.assignments?.length ? <div className="space-y-2">
                {details.tutor.assignments.map((assignment) => (
                  <article key={`${assignment.studentId}-${assignment.id}`} className="flex flex-col gap-2 rounded-xl border border-slate-800 bg-slate-950/70 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0"><p className="truncate text-sm font-semibold text-white">{assignment.studentName}</p><p className="mt-1 text-xs text-slate-400">{assignment.subject}{assignment.grade ? ` · ${assignment.grade}` : ''}</p></div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2"><StatusBadge status={assignment.accessRole} /><StatusBadge status={assignment.status} /></div>
                  </article>
                ))}
              </div> : <p className="rounded-xl border border-slate-800 bg-slate-950/70 p-4 text-sm text-slate-400">No assignment or access episodes are linked to this account.</p>}
            </SectionCard>
          </> : null}

          {user.role === 'parent' ? <SectionCard eyebrow="Linked accounts" title="Students" description="Students linked to this parent through the existing parentId relationship." icon={Users}>
            {details.parent?.students?.length ? <div className="grid gap-3 sm:grid-cols-2">
              {details.parent.students.map((student) => (
                <article key={student.id} className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                  <p className="font-semibold text-white">{student.name}</p>
                  {student.email ? <p className="mt-1 break-all text-sm text-slate-400">{student.email}</p> : null}
                  <p className="mt-2 text-xs text-slate-400">{student.grade || 'Grade not listed'}</p>
                </article>
              ))}
            </div> : <p className="rounded-xl border border-slate-800 bg-slate-950/70 p-4 text-sm text-slate-400">No linked student accounts are recorded for this parent.</p>}
          </SectionCard> : null}
        </> : null}
      </div>
    </AppShell>
  );
};
