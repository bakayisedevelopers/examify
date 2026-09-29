import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
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

export const LoginPage = () => {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [form, setForm] = useState({ email: 'something@example.com', password: 'password123' });
  const [status, setStatus] = useState('');

  const redirectByRole = (role) => navigate(`/${role}`);

  const handleSubmit = async (event) => {
    event.preventDefault();
    try {
      const result = await login(form);
      redirectByRole(result.profile.role);
    } catch (error) {
      setStatus(error.message);
    }
  };

  return (
    <main className="mx-auto flex min-h-[calc(100vh-88px)] max-w-7xl items-center px-4 py-16 lg:px-6">
      <div className="grid w-full gap-8 lg:grid-cols-[0.95fr_1.05fr]">
        <div className="panel-dark p-8 text-white">
          <p className="text-sm font-semibold uppercase tracking-[0.3em] text-brand-200">Access Examifying</p>
          <h1 className="mt-4 text-4xl font-bold">Welcome to Examifying.</h1>
          <div className="mt-8 space-y-3">
            {features.map(({ title, icon: Icon }) => (
              <div key={title} className="panel p-6 hover:-translate-y-2 transition">
                <Icon className="h-6 w-6 text-brand-700" />
                <p className="mt-3 text-sm text-slate-600">{title}</p>
              </div>
            ))}
          </div>
        </div>

        <form onSubmit={handleSubmit} className="panel space-y-5 p-8">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.3em] text-brand-700">Login</p>
            <h2 className="mt-2 text-3xl font-bold text-slate-950">Welcome back</h2>
            <Logo className="mt-4" />
          </div>
          <label className="block">
            <span className="label">Email</span>
            <input className="input" value={form.email} onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} />
          </label>
          <label className="block">
            <span className="label">Password</span>
            <input type="password" className="input" value={form.password} onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))} />
          </label>
          <div className="md:col-span-2 flex items-start gap-3 text-sm text-slate-600">
            <p>
              By login in you agree to Examifying {' '}
              <Link to="/policies#terms" className="font-semibold text-brand-700">
                Terms of Service
              </Link>,{' '}
              <Link to="/policies#refund" className="font-semibold text-brand-700">
                Refund & Cancellation Policy
              </Link>, and acknowledge that you have read and understood them, our contact information for any queries {' '}
              <Link to="/policies#contact" className="font-semibold text-brand-700">
                Contact Information
              </Link>.
            </p>
          </div>
          <button type="submit" className="btn-primary w-full">Login</button>
          {status ? <p className="text-sm text-rose-600">{status}</p> : null}
          <p className="text-sm text-slate-500">Need an account? <Link to="/signup" className="font-semibold text-brand-700">Create one</Link>.</p>
        </form>
      </div>
    </main>
  );
};
