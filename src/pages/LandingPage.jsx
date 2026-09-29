import {
  ArrowRight,
  BookOpen,
  BrainCircuit,
  CheckCircle2,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { Link, Navigate } from 'react-router-dom';
import { LandingSection } from '../components/landing/LandingSection';
import { SESSION_PRICING } from '../lib/constants';
import { useAuth } from '../hooks/useAuth';

const features = [
  {
    title: 'Daily subject exercises that unlock progressively',
    description:
      'Examifying assigns up to three exercises per day, but only from tutor-confirmed completed topics.',
    icon: BookOpen,
  },
  {
    title: 'Peer marking after submission',
    description:
      'Students review another learner’s uploaded answer image.',
    icon: Users,
  },
  {
    title: 'Tutor-led topic tracking and reports',
    description:
      'Tutors guide learning with visibility over every student’s progress.',
    icon: ShieldCheck,
  },
  {
    title: 'AI recommendations grounded in real data',
    description:
      'Smart recommendations based on real student performance.',
    icon: BrainCircuit,
  },
];

const benefits = [
  'Be exam ready.',
  'Question papers focused learning tailored for you.',
];

export const LandingPage = () => {
  const { profile } = useAuth();

  if (profile?.role) return <Navigate to={`/${profile.role}`} replace />;

  return (
    <div className="bg-slate-950 text-white">
      {/* ================= HERO ================= */}
      <section className="relative mx-auto max-w-7xl px-4 pb-20 pt-20 lg:px-6 lg:pt-24">
        
        {/* BACKGROUND GLOW */}
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_20%_20%,rgba(99,102,241,0.25),transparent_40%),radial-gradient(circle_at_80%_30%,rgba(168,85,247,0.2),transparent_40%)]" />

        <div className="grid items-start gap-10 lg:grid-cols-[1.1fr_0.9fr]">
          
          {/* LEFT */}
          <div className="rounded-3xl border border-white/10 bg-white/5 p-10 backdrop-blur-xl shadow-[0_25px_70px_rgba(0,0,0,0.7)]">
            
            <div className="inline-flex items-center gap-2 rounded-full border border-brand-400/30 bg-brand-500/10 px-4 py-2 text-sm font-semibold text-brand-200">
              70-20-10 subject learning
            </div>

            <h1 className="mt-6 text-5xl font-bold tracking-tight text-white md:text-6xl leading-tight">
              Structured daily subject practice,
              <span className="block bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">
                guided by tutors & AI
              </span>
            </h1>

            <p className="mt-6 text-lg text-slate-300">
              Examifying helps students stay consistent with structured exercises,
              peer review, and tutor-led progress tracking.
            </p>

            <div className="mt-10 flex flex-wrap gap-4">
              <Link
                to="/signup"
                className="group inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-indigo-500 to-purple-500 px-6 py-3 font-semibold text-white shadow-lg transition hover:scale-105"
              >
                Create account
                <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" />
              </Link>
            </div>

            <div className="mt-10 grid gap-4 md:grid-cols-2">
              {benefits.map((benefit) => (
                <div
                  key={benefit}
                  className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 p-4 hover:bg-white/10 transition"
                >
                  <CheckCircle2 className="h-5 w-5 text-green-400" />
                  <span className="text-slate-200">{benefit}</span>
                </div>
              ))}
            </div>
          </div>

          {/* RIGHT (FIXED POSITION - NO GAP) */}
          <div className="relative flex items-start justify-center min-h-[420px] -mt-0 lg:mt-10">
            
            <div className="absolute w-[400px] h-[400px] bg-indigo-500/20 blur-[120px] rounded-full" />

            <div className="relative w-full max-w-sm">

              {/* 70 */}
              <div className="absolute top-0 w-full rounded-3xl border border-white/20 bg-white/10 p-8 backdrop-blur-xl shadow-[0_25px_60px_rgba(0,0,0,0.6)] transform rotate-[-6deg] hover:rotate-0 hover:scale-105 transition duration-500">
                <p className="text-6xl font-extrabold text-white">70%</p>
                <p className="mt-2 text-xl font-bold text-white">
                  Daily exercise
                </p>
              </div>

              {/* 20 */}
              <div className="absolute top-[130px] right-0 w-11/12 rounded-3xl border border-purple-400/30 bg-purple-900/70 p-8 shadow-xl transform rotate-[6deg] hover:rotate-0 hover:scale-105 transition duration-500">
                <p className="text-5xl font-bold text-white">20%</p>
                <p className="mt-2 text-lg font-bold text-white">
                  Peer marking
                </p>
              </div>

              {/* 10 */}
              <div className="absolute top-[250px] left-0 w-10/12 rounded-3xl border border-slate-700/40 bg-slate-900/80 p-8 shadow-xl transform rotate-[-4deg] hover:rotate-0 hover:scale-105 transition duration-500">
                <p className="text-5xl font-bold text-white">10%</p>
                <p className="mt-2 text-lg font-bold text-white">
                  Tutor guidance
                </p>
              </div>

            </div>
          </div>
        </div>
      </section>

      {/* ================= FEATURES ================= */}
      <LandingSection
        eyebrow="Platform"
        title="Built for real learning"
        description="Designed for real student workflows."
      >
        <div className="grid gap-8 md:grid-cols-2 xl:grid-cols-4">
          {features.map(({ title, description, icon: Icon }) => (
            <div
              key={title}
              className="group rounded-3xl border border-white/10 bg-white/5 p-6 backdrop-blur-xl transition hover:-translate-y-3 hover:shadow-2xl"
            >
              <Icon className="h-7 w-7 text-indigo-400" />
              <h3 className="mt-4 text-lg font-semibold text-white">
                {title}
              </h3>
              <p className="mt-2 text-sm text-slate-300">
                {description}
              </p>
            </div>
          ))}
        </div>
      </LandingSection>

      {/* ================= PRICING ================= */}
      <LandingSection
        eyebrow="Pricing"
        title="Simple pricing"
        description="Clear and flexible pricing."
      >
        <div className="grid gap-8 lg:grid-cols-2">
          <div className="rounded-3xl border border-white/10 bg-white/5 p-8 backdrop-blur-xl shadow-xl">
            <p className="font-semibold text-white text-lg">
              Session pricing
            </p>
            <p className="mt-3 text-slate-300">
              Online: R{SESSION_PRICING.online}
            </p>
            <p className="text-slate-300">
              In-person: R{SESSION_PRICING.inPerson}
            </p>
          </div>

          <div className="rounded-3xl border border-white/10 bg-white/5 p-8 backdrop-blur-xl shadow-xl">
            <p className="font-semibold text-white text-lg">
              Recommended sessions
            </p>
            <p className="mt-3 text-slate-300">
              Below 70% → 4 sessions
            </p>
            <p className="text-slate-300">
              70% and above → 2 sessions
            </p>
          </div>
        </div>
      </LandingSection>

      {/* ================= PREMIUM FOOTER ================= */}
      <footer className="relative mt-28 border-t border-white/10 bg-slate-950">
        
        {/* glow */}
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(99,102,241,0.2),transparent_60%)]" />

        <div className="relative mx-auto max-w-7xl px-4 py-16 lg:px-6 grid gap-12 md:grid-cols-3">
          
          <div>
            <h2 className="text-2xl font-bold text-white tracking-wide">
              Examifying
            </h2>
            <p className="mt-4 text-sm text-slate-400 leading-relaxed">
              Structured learning powered by tutors and AI. Helping students
              become exam ready through consistency and guidance.
            </p>
          </div>

          <div>
            <p className="font-semibold text-white">Policies</p>
            <ul className="mt-4 space-y-3 text-sm text-slate-400">
              <li><Link to="/policies#terms" className="hover:text-white transition">Terms</Link></li>
              <li><Link to="/policies#privacy" className="hover:text-white transition">Privacy</Link></li>
              <li><Link to="/policies#refunds" className="hover:text-white transition">Refunds</Link></li>
            </ul>
          </div>

          <div>
            <p className="font-semibold text-white">Contact</p>
            <ul className="mt-4 space-y-3 text-sm text-slate-400">
              <li>Email: bakayise.developers@gmail.com</li>
              <li>South Africa</li>
            </ul>
          </div>
        </div>

        <div className="border-t border-white/10 py-6 text-center text-xs text-slate-500">
          © {new Date().getFullYear()} Examifying. All rights reserved.
        </div>
      </footer>
    </div>
  );
};
