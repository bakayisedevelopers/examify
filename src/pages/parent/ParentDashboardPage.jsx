import { useEffect, useState, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { AppShell } from '../../components/common/AppShell';
import { SectionHeader } from '../../components/common/SectionHeader';
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
    sessionType: student.sessionType || 'online',
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    onSave(form);
  };

  return (
    <form onSubmit={handleSubmit} className="p-4 bg-slate-50 rounded-xl space-y-4 shadow-sm mb-4">
      <div className="flex justify-between items-center bg-brand-50 -mx-4 -mt-4 p-4 rounded-t-xl mb-2 border-b border-brand-100">
        <h4 className="font-semibold text-brand-900">Edit Details</h4>
        <button type="button" onClick={onCancel} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5"/></button>
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
      <div>
        <label className="label">Session Type</label>
        <select 
          className="input w-full" 
          value={form.sessionType}
          onChange={(e) => setForm({...form, sessionType: e.target.value})}
        >
          <option value="online">Online</option>
          <option value="inPerson">In-person</option>
        </select>
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
  
  const lastVerifiedReferenceRef = useRef(null);

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
    const runVerification = async () => {
      if (!profile?.uid) return;

      const params = new URLSearchParams(location.search);
      const reference = params.get('reference') || params.get('trxref');

      if (!reference) return;
      if (lastVerifiedReferenceRef.current === reference) return;

      try {
        lastVerifiedReferenceRef.current = reference;
        setLoading(true);
        setStatus('Verifying your payment...');

        const verification = await verifySubscriptionPayment(reference);

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

  const handlePayForStudent = async (student) => {
    try {
      setLoading(true);
      const result = await initializeSubscriptionPayment({
        email: profile?.email,
        studentId: student.uid,
        latestMark: student.previousYearMark ?? 0,
        sessionType: student.sessionType ?? 'online',
        paidByParent: true,
        parentId: profile?.uid
      });

      if (!result?.authorizationUrl) {
        throw new Error('No Paystack authorization URL was returned.');
      }
      window.location.href = result.authorizationUrl;
    } catch (error) {
      alert(error?.message || 'Unable to initialize payment right now.');
      setLoading(false);
    }
  };

  const handlePayForAll = async () => {
    const unpaidStudents = students.filter(s => !s.paymentCompleted);
    if (unpaidStudents.length === 0) return;
    
    try {
      setLoading(true);
      const result = await initializeSubscriptionPayment({
        email: profile?.email,
        studentIds: unpaidStudents.map(s => ({
          id: s.uid,
          latestMark: s.previousYearMark ?? 0,
          sessionType: s.sessionType ?? 'online',
        })),
        paidByParent: true,
        parentId: profile?.uid
      });

      if (!result?.authorizationUrl) {
        throw new Error('No bulk Paystack authorization URL was returned.');
      }
      window.location.href = result.authorizationUrl;
    } catch (error) {
      alert(error?.message || 'Unable to process bulk payment right now.');
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
        <div className="mb-6 p-4 rounded-xl bg-slate-100 text-brand-700 flex items-center gap-2 text-sm font-medium">
          <AlertCircle className="w-4 h-4" />
          {status}
        </div>
      )}

      {students.length > 0 && (
        <div className="mb-6 flex justify-between items-center bg-brand-50 rounded-2xl p-6 border border-brand-100 shadow-sm">
          <div>
            <h3 className="font-bold text-slate-900 text-lg">Payments</h3>
            <p className="text-slate-600 text-sm mt-1">You have {unpaidCount} student{unpaidCount !== 1 && 's'} requiring payment updates.</p>
          </div>
          {unpaidCount > 0 && (
            <button 
              className="btn-primary px-8" 
              onClick={handlePayForAll}
              disabled={loading}
            >
              Pay for All At Once
            </button>
          )}
        </div>
      )}

      {students.length === 0 ? (
        <div className="py-12 bg-white rounded-2xl border border-dashed border-slate-300 flex flex-col items-center justify-center text-slate-500">
          <Users className="h-12 w-12 text-slate-300 mb-4" />
          <p className="text-lg font-medium text-slate-900">No students linked yet</p>
          <p className="text-sm">Link your child's account above to view their progress and manage payments.</p>
        </div>
      ) : (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {students.map((student) => (
            <div key={student.uid} className="panel p-0 flex flex-col overflow-hidden">
              <div className="bg-slate-50 p-6 border-b border-slate-100 flex justify-between items-start">
                <div>
                  <h3 className="text-lg font-bold text-slate-900">{student.displayName || student.email}</h3>
                  <p className="text-sm text-slate-500">{student.grade || 'Unknown Grade'} • {student.province || 'Unknown Region'}</p>
                </div>
                <button 
                  onClick={() => setEditingStudentId(editingStudentId === student.uid ? null : student.uid)}
                  className="p-2 bg-white border border-slate-200 rounded-lg text-slate-500 hover:text-brand-600 hover:border-brand-200 transition-colors"
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
                    <span className={`font-semibold px-2 py-1 rounded-md text-xs ${student.paymentCompleted ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
                      {student.paymentCompleted ? 'Active' : 'Pending Payment'}
                    </span>
                  </div>

                  {!student.paymentCompleted ? (
                    <button 
                      className="btn-primary w-full" 
                      onClick={() => handlePayForStudent(student)}
                      disabled={loading}
                    >
                      Pay Sub Individually
                    </button>
                  ) : (
                    <button className="btn-secondary w-full" disabled>
                      Subscription Active
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </AppShell>
  );
};
