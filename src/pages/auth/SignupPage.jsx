import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { REGIONS, ROLES, SOUTH_AFRICAN_GRADES } from '../../lib/constants';
import { useAuth } from '../../hooks/useAuth';
import { Logo } from '../../components/common/Logo';
import { normalizeWhatsAppNumber } from '../../utils/whatsapp';

export const SignupPage = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { register, profile, loading } = useAuth();
  const [creating, setCreating] = useState(false);

  const [form, setForm] = useState({
    fullName: '',
    email: '',
    password: '',
    role: ROLES.STUDENT,
    grade: SOUTH_AFRICAN_GRADES[0],
    province: REGIONS[0],
    school: '',
    whatsappNumber: '',
  });

  const [acceptedPolicies, setAcceptedPolicies] = useState(false);
  const [status, setStatus] = useState('');
  const pendingDiscountCode = new URLSearchParams(location.search).get('discountCode')?.toUpperCase() || '';

  if (loading) {
    return <main className="mx-auto flex min-h-[calc(100vh-88px)] max-w-2xl items-center justify-center px-4 py-12 text-sm text-slate-300">Loading your account…</main>;
  }

  if (profile?.role) {
    const selection = new URLSearchParams(location.search);
    if (profile.role === ROLES.STUDENT) {
      if (!['free', 'circle', 'personalized'].includes(selection.get('planId'))) {
        selection.set('planId', ['circle', 'personalized'].includes(profile.subscriptionPlanId) ? profile.subscriptionPlanId : 'circle');
      }
      if (!selection.has('billingPeriod')) selection.set('billingPeriod', profile.subscriptionBillingPeriod || 'monthly');
      if (!selection.has('subjectCount')) selection.set('subjectCount', String(profile.subscriptionSubjectCount || 1));
      return <Navigate to={`/student/billing?${selection.toString()}`} replace />;
    }
    if (profile.role === ROLES.PARENT && pendingDiscountCode) {
      return <Navigate to={`/parent?discountCode=${encodeURIComponent(pendingDiscountCode)}`} replace />;
    }
    return <Navigate to={profile.isTeacher ? '/teacher' : `/${profile.role}`} replace />;
  }

  if (pendingDiscountCode && new URLSearchParams(location.search).get('checkout') !== '1') {
    return <Navigate to={`/${location.search}`} replace />;
  }

  const handleChange = (key) => (event) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  const handleSubmit = async (event) => {
    event.preventDefault();

    setCreating(true);
    let whatsappNumber = '';

    if (form.role === ROLES.STUDENT) {
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
      if (!form.school.trim()) {
        setStatus('Please enter your school name.');
        setCreating(false);
        return;
      }
      try {
        whatsappNumber = normalizeWhatsAppNumber(form.whatsappNumber);
      } catch (error) {
        setStatus(error.message);
        setCreating(false);
        return;
      }
    }

    if (form.role === 'teacher') {
      if (!form.school.trim()) {
        setStatus('Please enter the school you are teaching in.');
        setCreating(false);
        return;
      }
    }

    try {
      const effectiveRole = form.role === 'teacher' ? ROLES.TUTOR : form.role;
      const result = await register({
        fullName: form.fullName,
        email: form.email,
        password: form.password,
        role: effectiveRole,
        policiesAccepted: true,
        policiesAcceptedAt: new Date().toISOString(),
        extraProfile: {
          grade: form.role === ROLES.STUDENT ? form.grade : null,
          province: form.role === ROLES.STUDENT ? form.province : null,
          school: (form.role === ROLES.STUDENT || form.role === 'teacher') ? form.school.trim() : null,
          ...(form.role === ROLES.STUDENT ? { whatsappNumber } : {}),
          isTeacher: form.role === 'teacher',
        },
      });

      const targetRoute = form.role === 'teacher' ? '/teacher' : `/${result.profile.role}`;
      const selection = new URLSearchParams(location.search);
      const planId = selection.get('planId');
      if (form.role === ROLES.STUDENT) {
        const selectedPlanId = ['free', 'circle', 'personalized'].includes(planId)
          ? planId
          : selection.has('discountCode') ? 'circle' : 'free';
        const billingPeriod = selection.get('billingPeriod') === 'yearly' ? 'yearly' : 'monthly';
        const subjectCount = selection.get('subjectCount') || '1';
        const discountCode = selection.get('discountCode');
        const billingParams = new URLSearchParams({ planId: selectedPlanId, billingPeriod, subjectCount });
        if (discountCode) billingParams.set('discountCode', discountCode.toUpperCase());
        navigate(`/student/billing?${billingParams.toString()}`);
      } else if (form.role === ROLES.PARENT && selection.get('discountCode')) {
        navigate(`/parent?discountCode=${encodeURIComponent(selection.get('discountCode').toUpperCase())}`);
      } else {
        navigate(targetRoute);
      }
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
          {pendingDiscountCode ? <p className="mt-4 rounded-xl border border-lime-400/20 bg-lime-400/5 p-3 text-sm text-lime-200">Discount code <span className="font-mono font-bold">{pendingDiscountCode}</span> will be checked securely in checkout after account creation.</p> : null}
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
            <option value="teacher">Teacher</option>
          </select>
        </label>

        {form.role === ROLES.STUDENT ? (
          <>
            <label className="block">
              <span className="label">School name</span>
              <input className="input" placeholder="e.g. Pretoria High School" value={form.school} onChange={handleChange('school')} required />
            </label>

            <label className="block">
              <span className="label">WhatsApp number</span>
              <input type="tel" inputMode="tel" autoComplete="tel" className="input" placeholder="082 123 4567 or +27 82 123 4567" value={form.whatsappNumber} onChange={handleChange('whatsappNumber')} required />
              <span className="mt-1 block text-xs text-slate-400">Required for lesson coordination. A South African number is saved with +27.</span>
            </label>

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

          </>
        ) : null}

        {form.role === 'teacher' ? (
          <label className="block md:col-span-2">
            <span className="label">School teaching in</span>
            <input className="input" placeholder="e.g. Johannesburg Secondary School" value={form.school} onChange={handleChange('school')} required />
          </label>
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
            disabled={(!acceptedPolicies || form.fullName.trim() === '' || form.email.trim() === '' || form.password.trim() === '' || (form.role === ROLES.STUDENT && (form.grade.trim() === 'Select Grade' || form.province.trim() === 'National' || !form.school.trim() || !form.whatsappNumber.trim())) || (form.role === 'teacher' && !form.school.trim())) || creating}
          >
            {creating ? 'Creating account...' : 'Create account'}
          </button>

          {status ? <p className="mt-3 text-sm text-rose-500">{status}</p> : null}

          <p className="mt-4 text-sm text-slate-400 text-center">
            Already have an account?{' '}
            <Link to={`/login${location.search}`} className="font-semibold text-lime-400 hover:text-lime-300 hover:underline">
              Log in
            </Link>.
          </p>
        </div>
      </form>
    </main>
  );
};
