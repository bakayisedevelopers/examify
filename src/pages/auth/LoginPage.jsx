import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { Logo } from '../../components/common/Logo';

export const LoginPage = () => {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [form, setForm] = useState({ email: '', password: '' });
  const [status, setStatus] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const redirectByRole = (profile) => {
    const target = profile.isTeacher ? '/teacher' : `/${profile.role}`;
    navigate(target);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setIsLoggingIn(true);
    setStatus('');
    try {
      const result = await login(form);
      redirectByRole(result.profile);
    } catch (error) {
      setStatus(error.message);
    } finally {
      setIsLoggingIn(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-[calc(100vh-88px)] max-w-lg items-center justify-center px-4 py-12 lg:px-6">
      <form onSubmit={handleSubmit} className="panel w-full space-y-5 p-8 border border-slate-800 bg-slate-900/90 shadow-2xl">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-lime-400">Login</p>
          <h2 className="mt-2 text-2xl sm:text-3xl font-bold text-white">Welcome back</h2>
          <Logo className="mt-4" />
        </div>
        <label className="block">
          <span className="label">Email</span>
          <input type="email" autoComplete="email" className="input" value={form.email} onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} disabled={isLoggingIn} required />
        </label>
        <label className="block">
          <span className="label">Password</span>
          <input type="password" autoComplete="current-password" className="input" value={form.password} onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))} disabled={isLoggingIn} required />
        </label>
        <div className="flex items-start gap-3 text-xs sm:text-sm text-slate-400">
          <p>
            By logging in you agree to Examifying{' '}
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
        <button type="submit" className="btn-primary w-full disabled:cursor-not-allowed disabled:opacity-70" disabled={isLoggingIn}>
          {isLoggingIn ? 'Logging in...' : 'Login'}
        </button>
        {status ? <p className="text-sm text-rose-500">{status}</p> : null}
        <p className="text-sm text-slate-400 text-center">
          Need an account? <Link to="/signup" className="font-semibold text-lime-400 hover:text-lime-300 hover:underline">Create one</Link>.
        </p>
      </form>
    </main>
  );
};
