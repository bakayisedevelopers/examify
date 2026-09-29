import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { REGIONS, ROLES, SOUTH_AFRICAN_GRADES } from '../../lib/constants';
import { useAuth } from '../../hooks/useAuth';
import { Logo } from '../../components/common/Logo';
import { BookOpen, BrainCircuit, ShieldCheck, Users } from 'lucide-react';

const features = [
  {
    title: 'Daily subject exercises that unlock progressively',
    icon: BookOpen,
  },
  {
    title: 'Peer marking after submission',
    icon: Users,
  },
  {
    title: 'Tutor-led topic tracking and reports',
    icon: ShieldCheck,
  },
  {
    title: 'AI recommendations grounded in real data',
    icon: BrainCircuit,
  },
];

export const SignupPage = () => {
  const navigate = useNavigate();
  const { register } = useAuth();
  const [creating, setCreating] = useState(false);

  const [form, setForm] = useState({
    fullName: '',
    email: '',
    password: '',
    role: ROLES.STUDENT,
    grade: SOUTH_AFRICAN_GRADES[0],
    province: REGIONS[0],
    previousYearMark: '0',
    sessionType: 'online',
  });

  const [acceptedPolicies, setAcceptedPolicies] = useState(false);
  const [status, setStatus] = useState('');

  const handleChange = (key) => (event) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  const handleSubmit = async (event) => {
    event.preventDefault();

    setCreating(true);

    console.log('Validating form', form);

    if (form.role.trim() === 'student') {
      if (form.grade.trim() === 'Select Grade') {
        setStatus('Please select a valid grade.');
        setCreating(false);
        return;
      }
      if (form.province.trim() === 'Select Province') {
        setStatus('Please select a valid province.');
        setCreating(false);
        return;
      }
    }

    try {
      const result = await register({
        fullName: form.fullName,
        email: form.email,
        password: form.password,
        role: form.role,
        latestReport: "",
        policiesAccepted: true,
        policiesAcceptedAt: new Date().toISOString(),
        extraProfile: {
          grade: form.role === ROLES.STUDENT ? form.grade : null,
          province: form.role === ROLES.STUDENT ? form.province : null,
          previousYearMark: form.role === ROLES.STUDENT ? Number(form.previousYearMark) : null,
          sessionType: form.role === ROLES.STUDENT ? form.sessionType : null,
        },
      });
      setCreating(false);
      navigate(
        result.profile.role === ROLES.STUDENT
          ? '/student/billing'
          : `/${result.profile.role}`
      );
    } catch (error) {
      console.error('[Examifying][Signup] submit:error', error);
      setStatus(error.message);
      setCreating(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-[calc(100vh-88px)] max-w-7xl items-center px-4 py-16 lg:px-6">
      <div className="grid w-full gap-8 lg:grid-cols-[0.95fr_1.05fr]">
        
        <div className="panel-dark p-8 text-white">
          <p className="text-sm font-semibold uppercase tracking-[0.3em] text-brand-200">
            Set up Examifying
          </p>
          <h1 className="mt-4 text-4xl font-bold">
            Create a real starter account for the platform.
          </h1>
          <p className="mt-4 text-slate-300">
            Students must enter their previous year’s mark manually so Examifying can recommend the monthly session count before payment.
          </p>
          <div className="mt-8 space-y-3">
            {features.map(({ title, icon: Icon }) => (
              <div key={title} className="panel p-6 hover:-translate-y-2 transition">
                <Icon className="h-6 w-6 text-brand-700" />
                <p className="mt-3 text-sm text-slate-600">{title}</p>
              </div>
            ))}
          </div>
        </div>

        <form onSubmit={handleSubmit} className="panel grid gap-5 p-8 md:grid-cols-2">
          
          <div className="md:col-span-2">
            <p className="text-sm font-semibold uppercase tracking-[0.3em] text-brand-700">
              Signup
            </p>
            <h2 className="mt-2 text-3xl font-bold text-slate-950">
              Create your account
            </h2>
            <Logo className="mt-4" />
          </div>

          <label>
            <span className="label">Full name</span>
            <input className="input" value={form.fullName} onChange={handleChange('fullName')} required />
          </label>

          <label>
            <span className="label">Email</span>
            <input type="email" className="input" value={form.email} onChange={handleChange('email')} required />
          </label>

          <label>
            <span className="label">Password</span>
            <input type="password" className="input" value={form.password} onChange={handleChange('password')} required minLength={6} />
          </label>

          <label>
            <span className="label">Role</span>
            <select className="input" value={form.role} onChange={handleChange('role')}>
              <option value={ROLES.STUDENT}>Student</option>
              <option value={ROLES.PARENT}>Parent</option>
              <option value={ROLES.TUTOR}>Tutor</option>
              <option value={ROLES.ADMIN}>Admin</option>
            </select>
          </label>

          {form.role === ROLES.STUDENT ? (
            <>
              <label>
                <span className="label">Grade</span>
                <select className="input" value={form.grade} onChange={handleChange('grade')}>
                  {SOUTH_AFRICAN_GRADES.map((grade) => <option key={grade}>{grade}</option>)}
                </select>
              </label>

              <label>
                <span className="label">Province</span>
                <select className="input" value={form.province} onChange={handleChange('province')}>
                  {REGIONS.map((region) => <option key={region}>{region}</option>)}
                </select>
              </label>

              <label>
                <span className="label">Previous year’s mark (%)</span>
                <input type="number" className="input" min="0" max="100" value={form.previousYearMark} onChange={handleChange('previousYearMark')} required />
              </label>

              <label>
                <span className="label">Preferred session type</span>
                <select className="input" value={form.sessionType} onChange={handleChange('sessionType')}>
                  <option value="online">Online</option>
                  <option value="inPerson">In-person</option>
                </select>
              </label>
            </>
          ) : null}

          {/* ✅ NEW: Policy Acceptance */}
          <div className="md:col-span-2 flex items-start gap-3 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={acceptedPolicies}
              onChange={(e) => setAcceptedPolicies(e.target.checked)}
              className="mt-1"
              required
            />
            <p>
              By login in you agree to Examifying {' '}
              <Link to="/policies#terms" className="font-semibold text-brand-700">
                Terms of Service
              </Link>,{' '}
              <Link to="/policies#refund" className="font-semibold text-brand-700">
                Refund & Cancellation Policy
              </Link>, and acknowledge that you have read and understood them, our contact information for any queries{' '}
              <Link to="/policies#contact" className="font-semibold text-brand-700">
                Contact Information
              </Link>.
            </p>
          </div>

          <div className="md:col-span-2">
            <button 
              type="submit"
              className="btn-primary w-full"
              disabled={(!acceptedPolicies || form.fullName.trim() === '' || form.email.trim() === '' || form.password.trim() === '' || (form.role.trim() === 'student' && form.grade.trim() === 'Select Grade') || (form.role.trim() === 'student' && form.province.trim() === 'National')) || creating}
            >
              {creating ? 'Creating account...' : 'Create account'}
            </button>

            {status ? <p className="mt-3 text-sm text-rose-600">{status}</p> : null}

            <p className="mt-4 text-sm text-slate-500">
              Already have an account?{' '}
              <Link to="/login" className="font-semibold text-brand-700">
                Log in
              </Link>.
            </p>
          </div>

        </form>
      </div>
    </main>
  );
};
