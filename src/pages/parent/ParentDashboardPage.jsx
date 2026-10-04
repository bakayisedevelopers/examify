import { useEffect, useState, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { AppShell } from '../../components/common/AppShell';
import { SectionHeader } from '../../components/common/SectionHeader';
import { SubscriptionLifecyclePanel } from '../../components/billing/SubscriptionLifecyclePanel';
import { SubscriptionPlanSelector } from '../../components/billing/SubscriptionPlanSelector';
import { 
  assignStudentToParent, 
  getStudentsForParent, 
  getStudentAccessState, 
  getTodayExercise,
  updateStudentProfileByParent 
} from '../../services/firestoreService';
import { initializeSubscriptionPayment, verifySubscriptionPayment } from '../../services/paymentsService';
import { Users, Link as LinkIcon, AlertCircle, Edit, Check, X, Calendar, Activity } from 'lucide-react';

const EditDetailsForm = ({ student, onSave, onCancel }) => {
  const [form, setForm] = useState({
    displayName: student.displayName || '',
    previousYearMark: student.previousYearMark || 0,
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    onSave(form);
  };

  return (
    <form onSubmit={handleSubmit} className="p-4 bg-slate-900/90 border border-slate-700 rounded-xl space-y-4 shadow-sm mb-4">
      <div className="flex justify-between items-center bg-lime-400/10 -mx-4 -mt-4 p-4 rounded-t-xl mb-2 border-b border-lime-400/20">
        <h4 className="font-semibold text-white">Edit Details</h4>
        <button type="button" onClick={onCancel} className="text-slate-400 hover:text-slate-200"><X className="w-5 h-5"/></button>
      </div>
      <div>
        <label className="label">Name</label>
        <input 
          type="text" 
          className="input w-full" 
          value={form.displayName}
          onChange={(e) => setForm({...form, displayName: e.target.value})}
          required
        />
      </div>
      <div>
        <label className="label">Start/Prev Mark (%)</label>
        <input 
          type="number" 
          className="input w-full" 
          value={form.previousYearMark}
          onChange={(e) => setForm({...form, previousYearMark: e.target.value})}
          required
        />
      </div>
      <button type="submit" className="btn-primary w-full flex justify-center items-center gap-2">
        <Check className="w-4 h-4"/> Save Details
      </button>
    </form>
  );
};

export const ParentDashboardPage = () => {
  const { profile, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [students, setStudents] = useState([]);
  const [studentIdInput, setStudentIdInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [editingStudentId, setEditingStudentId] = useState(null);
  const [subscriptionStudent, setSubscriptionStudent] = useState(null);
  
  const lastVerifiedReferenceRef = useRef(null);
  const handledDiscountLinkRef = useRef('');

  const loadStudents = async () => {
    if (!profile?.uid) return;
    try {
      const parentStudents = await getStudentsForParent(profile.uid);
      
      const enrichedStudents = await Promise.all(
        parentStudents.map(async (student) => {
          const accessState = await getStudentAccessState(student);
          const todayExercise = await getTodayExercise(student.uid);
          return {
            ...student,
            completedLessonsCount: accessState.completedLessons?.length || 0,
            todayExercise: todayExercise,
            paymentCompleted: accessState.paymentCompleted, 
            subscriptionPlanId: accessState.subscriptionPlanId,
            subscriptionPlanName: accessState.subscriptionPlanName,
            subscriptionStatus: accessState.subscriptionStatus,
            subscriptionBillingPeriod: accessState.subscriptionBillingPeriod,
            subscriptionSubjectCount: accessState.subscriptionSubjectCount,
            subscriptionRenewalDate: accessState.subscriptionRenewalDate,
            requiresSubscriptionSelection: accessState.requiresSubscriptionSelection,
            autoRenew: accessState.autoRenew,
            cancelAtPeriodEnd: accessState.cancelAtPeriodEnd,
            pendingPlan: accessState.pendingPlan,
            pendingPlanReference: accessState.pendingPlanReference,
            graceEndsAt: accessState.graceEndsAt,
            renewalAttemptCount: accessState.renewalAttemptCount,
            nextRenewalAttemptAt: accessState.nextRenewalAttemptAt,
            manualPaymentRequired: accessState.manualPaymentRequired,
          };
        })
      );
      
      setStudents(enrichedStudents);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    loadStudents();
  }, [profile?.uid]);

  useEffect(() => {
    const code = new URLSearchParams(location.search).get('discountCode')?.trim().toUpperCase() || '';
    if (!code || !students.length || handledDiscountLinkRef.current === code) return;
    handledDiscountLinkRef.current = code;
    if (students.length === 1) {
      setSubscriptionStudent(students[0]);
    } else {
      setStatus(`Discount code ${code} is ready. Choose a student’s subscription below to apply it.`);
    }
  }, [location.search, students]);

  useEffect(() => {
    const runVerification = async () => {
      if (!profile?.uid) return;

      const params = new URLSearchParams(location.search);
      const reference = params.get('reference') || params.get('trxref');
      const paymentStudentId = params.get('studentId');

      if (!reference || !paymentStudentId) return;
      if (lastVerifiedReferenceRef.current === reference) return;

      try {
        lastVerifiedReferenceRef.current = reference;
        setLoading(true);
        setStatus('Verifying your payment...');

        const verification = await verifySubscriptionPayment(reference, paymentStudentId);

        if (verification?.status !== 'success') {
          setStatus(`Payment verification returned status: ${verification?.status ?? 'unknown'}`);
          return;
        }

        setStatus('Payment verified successfully!');
        await loadStudents();
        navigate(location.pathname, { replace: true });
      } catch (error) {
        setStatus(error?.message || 'Payment verification failed.');
      } finally {
        setLoading(false);
      }
    };

    runVerification();
  }, [location.pathname, location.search, navigate, profile?.uid]);

  const handleLinkStudent = async (e) => {
    e.preventDefault();
    if (!studentIdInput.trim()) return;
    
    setLoading(true);
    setStatus('');
    try {
      await assignStudentToParent({
        parentId: profile.uid,
        studentIdentifier: studentIdInput.trim(),
      });
      setStatus('Student successfully linked!');
      setStudentIdInput('');
      await loadStudents();
    } catch (err) {
      setStatus(err.message || 'Failed to link student.');
    } finally {
      setLoading(false);
    }
  };

  const handleSaveDetails = async (studentId, form) => {
    try {
      setLoading(true);
      await updateStudentProfileByParent({
        parentId: profile.uid,
        studentId,
        updates: form
      });
      setEditingStudentId(null);
      await loadStudents();
      setStatus('Student details updated.');
    } catch (err) {
      setStatus(err.message || 'Failed to update details');
    } finally {
      setLoading(false);
    }
  };

  const handlePayForStudent = async (student, selection) => {
    try {
      setLoading(true);
      const result = await initializeSubscriptionPayment({
        studentId: student.uid,
        ...selection,
        callbackUrl: `${window.location.origin}${location.pathname}`,
      });

      if (result.freeCheckout) {
        const renewalNote = result.discount?.billingDuration === 'recurring' && result.discount?.percentOff === 100
          ? ' This permanent 100% code will continue the same plan as zero-cost renewal cycles.'
          : result.discount?.billingDuration === 'fixed_months' && result.discount?.percentOff === 100
            ? ` The 100% discount covers the first ${result.discount.discountDurationMonths} monthly billing periods; manual payment is needed after that period because no reusable card authorization was created.`
            : ' Automatic renewal requires a successful card payment and reusable authorization.';
        setStatus(`${student.displayName || 'Student'} subscription activated with the discount code.${renewalNote}`);
        setSubscriptionStudent(null);
        await loadStudents();
      } else if (result.free) {
        setStatus(`${student.displayName || 'Student'} is now on the Free plan.`);
        setSubscriptionStudent(null);
        await loadStudents();
      } else if (result.scheduledChange) {
        setStatus(`${result.quote.planName} will start for ${student.displayName || 'the student'} on ${new Date(result.effectiveAt).toLocaleDateString()}.${result.manualPaymentRequired ? ' Payment will be required then.' : ''}`);
        setSubscriptionStudent(null);
        await loadStudents();
      } else if (result.pendingChangeCancelled) {
        setStatus(`The scheduled change for ${student.displayName || 'the student'} was cancelled.`);
        setSubscriptionStudent(null);
        await loadStudents();
      } else if (result.alreadyActive) {
        setStatus(result.renewalCancelled
          ? `${result.quote.planName} is active until ${new Date(result.renewalDate).toLocaleDateString()}; automatic renewal is cancelled.`
          : `${result.quote.planName} is already active for ${student.displayName || 'the student'}.`);
        setSubscriptionStudent(null);
      } else if (!result?.authorizationUrl) {
        throw new Error('No Paystack authorization URL was returned.');
      } else {
        window.location.href = result.authorizationUrl;
      }
    } catch (error) {
      setStatus(error?.message || 'Unable to start subscription checkout.');
    } finally {
      setLoading(false);
    }
  };

  const unpaidCount = students.filter(s => !s.paymentCompleted).length;

  return (
    <AppShell
      title="Parent Dashboard"
      subtitle="Manage your children's accounts, track learning progress, and handle subscriptions."
      role="parent"
      user={profile}
      onLogout={logout}
    >
      <SectionHeader 
        eyebrow="Linked Students" 
        title="Your Children" 
        description="Add students using their email or Examifying ID. You can manage multiple students from this panel."
      />
      
      <div className="panel p-6 mb-8 flex flex-col md:flex-row gap-4 items-end">
        <div className="flex-1 w-full">
          <label className="label block mb-2">Student Email</label>
          <input 
            type="text" 
            className="input w-full" 
            placeholder="e.g. ayanda@example.com"
            value={studentIdInput}
            onChange={(e) => setStudentIdInput(e.target.value)}
          />
        </div>
        <button 
          className="btn-primary whitespace-nowrap px-6 py-2 flex items-center gap-2 h-[42px]" 
          onClick={handleLinkStudent}
          disabled={loading || !studentIdInput.trim()}
        >
          <LinkIcon className="h-4 w-4" />
          Link Student
        </button>
      </div>
      
      {status && (
        <div className="mb-6 p-4 rounded-xl border border-lime-400/30 bg-lime-400/10 text-lime-300 flex items-center gap-2 text-sm font-medium">
          <AlertCircle className="w-4 h-4" />
          {status}
        </div>
      )}

      {students.length > 0 && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-lime-400/30 bg-lime-400/10 p-6 shadow-sm">
          <div>
            <h3 className="font-bold text-white text-lg">Payments</h3>
            <p className="text-slate-300 text-sm mt-1">{unpaidCount} student{unpaidCount !== 1 ? 's' : ''} need a subscription. Choose a plan for each student.</p>
          </div>
        </div>
      )}

      {students.length === 0 ? (
        <div className="py-12 bg-slate-900/60 rounded-2xl border border-dashed border-slate-700 flex flex-col items-center justify-center text-slate-400">
          <Users className="h-12 w-12 text-slate-500 mb-4" />
          <p className="text-lg font-medium text-white">No students linked yet</p>
          <p className="text-sm">Link your child's account above to view their progress and manage payments.</p>
        </div>
      ) : (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {students.map((student) => (
            <div key={student.uid} className="panel p-0 flex flex-col overflow-hidden">
              <div className="bg-slate-900/90 p-6 border-b border-slate-800 flex justify-between items-start">
                <div>
                  <h3 className="text-lg font-bold text-white">{student.displayName || student.email}</h3>
                  <p className="text-sm text-slate-400">{student.grade || 'Unknown Grade'} • {student.province || 'Unknown Region'}</p>
                </div>
                <button 
                  onClick={() => setEditingStudentId(editingStudentId === student.uid ? null : student.uid)}
                  className="p-2 bg-slate-800 border border-slate-700 rounded-lg text-slate-400 hover:text-lime-400 hover:border-lime-400/50 transition-colors"
                  title="Edit Profile"
                >
                  <Edit className="w-4 h-4" />
                </button>
              </div>

              <div className="p-6 flex-1 flex flex-col">
                {editingStudentId === student.uid ? (
                  <EditDetailsForm 
                    student={student} 
                    onSave={(form) => handleSaveDetails(student.uid, form)}
                    onCancel={() => setEditingStudentId(null)}
                  />
                ) : (
                  <>
                    <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Progress & Status</h4>
                    <div className="space-y-4 mb-6">
                      <div className="flex items-center gap-3">
                        <Activity className="w-5 h-5 text-brand-600" />
                        <div>
                          <p className="text-sm font-medium text-slate-900">{student.completedLessonsCount} Completed Topics</p>
                          <p className="text-xs text-slate-500">Starting Mark: {student.previousYearMark || 0}%</p>
                        </div>
                      </div>

                      <div className="flex items-center gap-3">
                        <Calendar className={`w-5 h-5 ${student.todayExercise ? 'text-emerald-600' : 'text-slate-400'}`} />
                        <div>
                          <p className="text-sm font-medium text-slate-900">
                            {student.todayExercise ? 'Today\'s Exercise Available' : 'No Exercise Today'}
                          </p>
                          {student.todayExercise && (
                            <p className="text-xs text-slate-500 truncate max-w-[200px]" title={student.todayExercise.title}>
                              {student.todayExercise.submittedImageUrl ? '✅ Submitted' : '⏳ Pending'} • {student.todayExercise.title}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  </>
                )}

                <div className="mt-auto pt-4 border-t border-slate-100">
                  <div className="flex justify-between items-center mb-4 text-sm">
                    <span className="text-slate-500">Subscription Status</span>
                    <span className={`font-semibold px-2 py-1 rounded-md text-xs ${student.subscriptionStatus === 'past_due' ? 'bg-amber-50 text-amber-700' : student.paymentCompleted ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
                      {student.subscriptionStatus === 'past_due' ? 'Payment due' : student.cancelAtPeriodEnd ? 'Ends this period' : student.paymentCompleted ? 'Active' : 'Free'}
                    </span>
                  </div>

                  {!student.paymentCompleted ? (
                    <button 
                      className="btn-primary w-full" 
                      onClick={() => setSubscriptionStudent(student)}
                      disabled={loading}
                    >
                      Choose subscription
                    </button>
                  ) : (
                    <button className="btn-secondary w-full" onClick={() => setSubscriptionStudent(student)} disabled={loading}>
                      {student.paymentCompleted ? 'Manage subscription' : 'Choose subscription'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {subscriptionStudent ? (
        <div className="fixed inset-0 z-[80] overflow-y-auto bg-slate-950/95 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={`Subscription for ${subscriptionStudent.displayName || 'student'}`}>
          <div className="mx-auto my-4 max-w-6xl">
            <div className="mb-5 flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.25em] text-lime-400">Student subscription</p>
                <h2 className="mt-1 text-2xl font-bold text-white">{subscriptionStudent.displayName || subscriptionStudent.email}</h2>
              </div>
              <button type="button" className="btn-secondary h-11 w-11 p-0" onClick={() => setSubscriptionStudent(null)} aria-label="Close subscription plans"><X className="h-5 w-5" /></button>
            </div>
            <div className="mb-5">
              <SubscriptionLifecyclePanel
                studentId={subscriptionStudent.uid}
                subscriptionState={subscriptionStudent}
                onStateChange={(nextState) => {
                  setSubscriptionStudent((current) => current ? { ...current, ...nextState } : current);
                  loadStudents();
                }}
                onContinuePayment={() => {
                  const selection = subscriptionStudent.pendingPlan || subscriptionStudent;
                  handlePayForStudent(subscriptionStudent, {
                    planId: selection.planId || subscriptionStudent.subscriptionPlanId,
                    billingPeriod: selection.billingPeriod || subscriptionStudent.subscriptionBillingPeriod || 'monthly',
                    subjectCount: selection.subjectCount || subscriptionStudent.subscriptionSubjectCount || 1,
                  });
                }}
              />
            </div>
            <SubscriptionPlanSelector
              studentId={subscriptionStudent.uid}
              initialDiscountCode={new URLSearchParams(location.search).get('discountCode') || ''}
              key={`${subscriptionStudent.pendingPlan?.planId || subscriptionStudent.subscriptionPlanId}-${subscriptionStudent.pendingPlan?.billingPeriod || subscriptionStudent.subscriptionBillingPeriod}-${subscriptionStudent.pendingPlan?.subjectCount || subscriptionStudent.subscriptionSubjectCount}`}
              initialSelection={{
                planId: subscriptionStudent.pendingPlan?.planId || subscriptionStudent.subscriptionPlanId,
                billingPeriod: subscriptionStudent.pendingPlan?.billingPeriod || subscriptionStudent.subscriptionBillingPeriod,
                subjectCount: subscriptionStudent.pendingPlan?.subjectCount || subscriptionStudent.subscriptionSubjectCount,
              }}
              onContinue={(selection) => handlePayForStudent(subscriptionStudent, selection)}
              isSubmitting={loading}
            />
          </div>
        </div>
      ) : null}
    </AppShell>
  );
};
