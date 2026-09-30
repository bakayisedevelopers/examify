import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { REGIONS, ROLES, SOUTH_AFRICAN_GRADES } from '../../lib/constants';
import { useAuth } from '../../hooks/useAuth';
import { Logo } from '../../components/common/Logo';

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

    if (form.role.trim() === 'student') {
      if (form.grade.trim() === 'Select Grade') {
        setStatus('Please select a valid grade.');
        setCreating(false);
        return;
      }
      if (form.province.trim() === 'Select Province' || form.province.trim() === 'National') {
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
        latestReport: '',
        policiesAccepted: true,
        policiesAcceptedAt: new Date().toISOString(),
        extraProfile: {
          grade: form.role === ROLES.STUDENT ? form.grade : null,
          province: form.role === ROLES.STUDENT ? form.province : null,
          previousYearMark: form.role === ROLES.STUDENT ? Number(form.previousYearMark) || 0 : null,
          preferredSessionType: form.role === ROLES.STUDENT ? form.sessionType : null,
        },
      });

      navigate(`/${result.profile.role}`);
    } catch (error) {
      console.error('Registration failed:', error);
      setStatus(error.message || 'Registration failed');
    } finally {
      setCreating(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-[calc(100vh-88px)] max-w-2xl items-center justify-center px-4 py-12 lg:px-6">
      <form onSubmit={handleSubmit} className="panel w-full grid gap-5 p-8 md:grid-cols-2 border border-slate-800 bg-slate-900/90 shadow-2xl">
        <div className="md:col-span-2">
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-lime-400">
            Signup
          </p>
          <h2 className="mt-2 text-2xl sm:text-3xl font-bold text-white">
            Create your account
          </h2>
          <Logo className="mt-4" />
        </div>

        <label className="block">
          <span className="label">Full name</span>
          <input className="input" value={form.fullName} onChange={handleChange('fullName')} required />
        </label>

        <label className="block">
          <span className="label">Email</span>
          <input type="email" className="input" value={form.email} onChange={handleChange('email')} required />
        </label>

        <label className="block">
          <span className="label">Password</span>
          <input type="password" className="input" value={form.password} onChange={handleChange('password')} required minLength={6} />
        </label>

        <label className="block">
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
            <label className="block">
              <span className="label">Grade</span>
              <select className="input" value={form.grade} onChange={handleChange('grade')}>
                {SOUTH_AFRICAN_GRADES.map((grade) => <option key={grade}>{grade}</option>)}
              </select>
            </label>

            <label className="block">
              <span className="label">Province</span>
              <select className="input" value={form.province} onChange={handleChange('province')}>
                {REGIONS.map((region) => <option key={region}>{region}</option>)}
              </select>
            </label>

            <label className="block">
              <span className="label">Previous year’s mark (%)</span>
              <input type="number" className="input" min="0" max="100" value={form.previousYearMark} onChange={handleChange('previousYearMark')} required />
            </label>

            <label className="block">
              <span className="label">Preferred session type</span>
              <select className="input" value={form.sessionType} onChange={handleChange('sessionType')}>
                <option value="online">Online</option>
                <option value="inPerson">In-person</option>
              </select>
            </label>
          </>
        ) : null}

        <div className="md:col-span-2 flex items-start gap-3 text-xs sm:text-sm text-slate-400">
          <input
            type="checkbox"
            checked={acceptedPolicies}
            onChange={(e) => setAcceptedPolicies(e.target.checked)}
            className="mt-1 accent-lime-400"
            required
          />
          <p>
            By creating an account you agree to Examifying{' '}
            <Link to="/policies#terms" className="font-semibold text-lime-400 hover:text-lime-300 hover:underline">
              Terms of Service
            </Link>,{' '}
            <Link to="/policies#refunds" className="font-semibold text-lime-400 hover:text-lime-300 hover:underline">
              Refund Policy
            </Link>, and acknowledge our{' '}
            <Link to="/policies#contact" className="font-semibold text-lime-400 hover:text-lime-300 hover:underline">
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

          {status ? <p className="mt-3 text-sm text-rose-500">{status}</p> : null}

          <p className="mt-4 text-sm text-slate-400 text-center">
            Already have an account?{' '}
            <Link to="/login" className="font-semibold text-lime-400 hover:text-lime-300 hover:underline">
              Log in
            </Link>.
          </p>
        </div>
      </form>
    </main>
  );
};
