import { useEffect, useRef } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Camera,
  CheckCircle2,
  Clock,
  FileCheck2,
  Flame,
  GraduationCap,
  Lock,
  ShieldCheck,
  Sparkles,
  Users,
} from 'lucide-react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { SubscriptionPlanSelector } from '../components/billing/SubscriptionPlanSelector';

import heroMathsImg from '../assets/images/hero_maths_learning_1790782334325.jpg';
import dailyExerciseImg from '../assets/images/feature_daily_exercise_1790782345431.jpg';
import peerMarkingImg from '../assets/images/feature_peer_marking_1790782355192.jpg';

export const LandingPage = () => {
  const { profile, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const pricingSectionRef = useRef(null);
  const initialDiscountCode = new URLSearchParams(location.search).get('discountCode') || '';
  const linkSelection = new URLSearchParams(location.search);
  const signupSelection = new URLSearchParams(location.search);
  if (initialDiscountCode) {
    signupSelection.set('checkout', '1');
    if (!signupSelection.has('planId')) signupSelection.set('planId', 'circle');
    if (!signupSelection.has('billingPeriod')) signupSelection.set('billingPeriod', 'monthly');
    if (!signupSelection.has('subjectCount')) signupSelection.set('subjectCount', '1');
  }
  const signupQuery = signupSelection.toString();
  const signupPath = signupQuery ? `/signup?${signupQuery}` : '/signup';
  const loginPath = location.search ? `/login${location.search}` : '/login';

  useEffect(() => {
    if (authLoading || profile?.role || !initialDiscountCode) return undefined;
    const frame = window.requestAnimationFrame(() => {
      pricingSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [authLoading, initialDiscountCode, profile?.role]);

  const continueFromPricing = ({ planId, billingPeriod, subjectCount, discountCode }) => {
    const params = new URLSearchParams({ planId, billingPeriod, subjectCount: String(subjectCount) });
    if (discountCode) params.set('discountCode', discountCode);
    if (profile?.role === 'student') {
      navigate(`/student/billing?${params.toString()}`);
    } else if (profile?.role === 'parent') {
      navigate(`/parent?discountCode=${encodeURIComponent(discountCode || initialDiscountCode)}`);
    } else {
      params.set('checkout', '1');
      navigate(`/signup?${params.toString()}`);
    }
  };

  if (profile?.role) {
    const selection = new URLSearchParams(location.search);
    if (selection.has('discountCode') && profile.role === 'student') {
      return <Navigate to={`/student/billing?${selection.toString()}`} replace />;
    }
    if (selection.has('discountCode') && profile.role === 'parent') {
      return <Navigate to={`/parent?discountCode=${encodeURIComponent(selection.get('discountCode'))}`} replace />;
    }
    const target = (profile.role === 'tutor' && profile.isTeacher) ? '/teacher' : `/${profile.role}`;
    return <Navigate to={target} replace />;
  }

  return (
    <div className="bg-slate-950 text-slate-100 overflow-hidden font-sans">
      {/* ================= HERO SECTION ================= */}
      <section className="relative mx-auto max-w-7xl px-4 pt-12 pb-20 lg:px-6 lg:pt-16 lg:pb-28">
        {/* Glow ambient meshes */}
        <div className="pointer-events-none absolute -top-32 left-1/2 -z-10 h-[600px] w-[800px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle_at_center,rgba(163,230,53,0.18)_0%,rgba(16,185,129,0.08)_40%,transparent_70%)] blur-3xl" />
        <div className="pointer-events-none absolute top-48 right-0 -z-10 h-[400px] w-[400px] rounded-full bg-[radial-gradient(circle_at_center,rgba(190,242,100,0.12)_0%,transparent_70%)] blur-2xl" />

        <div className="grid items-center gap-12 lg:grid-cols-[1.1fr_0.9fr]">
          {/* Left Column: Value Prop */}
          <div className="space-y-6">
            <div className="inline-flex items-center gap-2.5 rounded-full border border-lime-400/40 bg-lime-400/10 px-4 py-1.5 text-xs font-bold uppercase tracking-[0.18em] text-lime-300 shadow-[0_0_20px_rgba(163,230,53,0.2)] backdrop-blur">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-lime-400 opacity-75"></span>
                <span className="relative inline-flex h-2 w-2 rounded-full bg-lime-400"></span>
              </span>
              The 70 - 20 - 10 Mathematics Platform
            </div>

            <h1 className="text-4xl font-black tracking-tight text-white sm:text-5xl lg:text-6xl leading-[1.08]">
              Master Mathematics through{' '}
              <span className="bg-gradient-to-r from-lime-300 via-lime-400 to-emerald-400 bg-clip-text text-transparent underline decoration-lime-400/30 decoration-wavy underline-offset-8">
                daily practice
              </span>
              , peer review & tutor guidance.
            </h1>

            <p className="max-w-2xl text-lg text-slate-300 font-normal leading-relaxed">
              Examifying structures your high school Mathematics routine using the proven 70-20-10 learning framework. Practice daily on paper, review peers to sharpen your eye, and let your dedicated tutor guide your syllabus roadmap.
            </p>

            <div className="flex flex-wrap items-center gap-4 pt-2">
              <Link
                to={signupPath}
                className="group relative inline-flex items-center gap-2.5 rounded-full bg-gradient-to-r from-lime-400 via-lime-300 to-emerald-400 px-8 py-4 text-base font-extrabold text-slate-950 shadow-[0_0_35px_rgba(163,230,53,0.4)] transition-all duration-300 hover:scale-[1.03] hover:shadow-[0_0_50px_rgba(163,230,53,0.6)] active:scale-100"
              >
                <span>Create student account</span>
                <ArrowRight className="h-5 w-5 transition-transform duration-300 group-hover:translate-x-1" />
              </Link>
              <Link
                to={loginPath}
                className="inline-flex items-center gap-2 rounded-full border border-lime-400/30 bg-slate-900/70 px-6 py-4 text-sm font-semibold text-lime-300 backdrop-blur transition-all duration-200 hover:border-lime-400 hover:bg-lime-400/10 hover:text-white"
              >
                <span>Log in</span>
              </Link>
            </div>

            {/* Core Rules Checklist */}
            <div className="grid gap-3 pt-2 sm:grid-cols-2">
              {[
                '70% Daily exercises (today only)',
                '20% Anonymous peer review',
                '10% Dedicated tutor oversight',
                'Handwritten answer photo uploads',
              ].map((benefit) => (
                <div
                  key={benefit}
                  className="flex items-center gap-2.5 rounded-2xl border border-white/5 bg-slate-900/60 p-3 backdrop-blur-sm transition-colors hover:border-lime-400/30"
                >
                  <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-lime-400/20 text-lime-400">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  </div>
                  <span className="text-xs sm:text-sm font-medium text-slate-200">{benefit}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Right Column: Clean Studio Visual with 70-20-10 badges */}
          <div className="relative lg:pl-4">
            <div className="absolute -inset-2 rounded-3xl bg-gradient-to-tr from-lime-500/20 via-emerald-500/10 to-transparent blur-2xl" />

            <div className="relative rounded-3xl border border-lime-500/30 bg-slate-900/80 p-3 shadow-[0_20px_60px_rgba(0,0,0,0.8)] backdrop-blur-xl">
              <div className="relative overflow-hidden rounded-2xl border border-white/10 aspect-[4/3]">
                <img
                  src={heroMathsImg}
                  alt="Examifying Mathematics Study Environment"
                  className="h-full w-full object-cover transition-transform duration-700 hover:scale-105"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-slate-950/70 via-transparent to-transparent" />
              </div>

              {/* 70-20-10 Method Summary Badges */}
              <div className="mt-3 grid grid-cols-3 gap-2">
                <div className="rounded-xl border border-lime-400/40 bg-lime-400/10 p-3 text-center">
                  <span className="block text-2xl font-black text-lime-400">70%</span>
                  <span className="text-[10px] sm:text-[11px] font-bold uppercase tracking-wider text-slate-200">
                    Daily Exercise
                  </span>
                </div>
                <div className="rounded-xl border border-white/10 bg-slate-800/80 p-3 text-center">
                  <span className="block text-2xl font-black text-emerald-400">20%</span>
                  <span className="text-[10px] sm:text-[11px] font-bold uppercase tracking-wider text-slate-300">
                    Peer Marking
                  </span>
                </div>
                <div className="rounded-xl border border-white/10 bg-slate-800/80 p-3 text-center">
                  <span className="block text-2xl font-black text-slate-200">10%</span>
                  <span className="text-[10px] sm:text-[11px] font-bold uppercase tracking-wider text-slate-400">
                    Tutor Guidance
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ================= THE 70 - 20 - 10 METHOD EXPLAINED ================= */}
      <section className="relative border-y border-lime-500/20 bg-slate-900/40 py-20">
        <div className="mx-auto max-w-7xl px-4 lg:px-6">
          <div className="mx-auto max-w-3xl text-center space-y-4">
            <div className="inline-flex items-center gap-2 rounded-full border border-lime-400/40 bg-lime-400/10 px-4 py-1.5 text-xs font-bold uppercase tracking-[0.2em] text-lime-300">
              <Sparkles className="h-3.5 w-3.5 text-lime-400" />
              The Examifying Method
            </div>
            <h2 className="text-3xl font-black tracking-tight text-white md:text-5xl">
              How the 70 - 20 - 10 method is structured in the app.
            </h2>
            <p className="text-base sm:text-lg text-slate-300 leading-relaxed">
              Cognitive science proves that reading notes creates an illusion of competence. Examifying turns passive study into high-retention active mathematics mastery.
            </p>
          </div>

          <div className="mt-14 grid gap-8 lg:grid-cols-3">
            {/* Pillar 1: 70% Daily Practice */}
            <div className="group relative rounded-3xl border border-lime-500/40 bg-slate-900/90 p-6 shadow-xl backdrop-blur transition-all duration-300 hover:-translate-y-2 hover:border-lime-400 hover:shadow-[0_15px_40px_rgba(163,230,53,0.15)] flex flex-col justify-between">
              <div>
                <div className="relative mb-6 overflow-hidden rounded-2xl border border-lime-500/20 aspect-video">
                  <img
                    src={dailyExerciseImg}
                    alt="Daily Mathematics Practice"
                    className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                  />
                  <div className="absolute top-3 left-3 rounded-full bg-lime-400 px-3 py-1 text-xs font-black text-slate-950 shadow-md">
                    70% Doing
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-lime-400/20 text-lime-400">
                    <Flame className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold text-white">70% Daily Exercises</h3>
                    <p className="text-xs text-lime-400 font-semibold">Active Problem Solving</p>
                  </div>
                </div>

                <p className="mt-4 text-sm leading-relaxed text-slate-300">
                  Every day, the platform generates targeted math problems based strictly on topics your tutor confirmed you have completed.
                </p>

                <div className="mt-5 space-y-3 rounded-2xl border border-white/5 bg-slate-950/60 p-4 text-xs text-slate-300">
                  <div className="flex items-start gap-2.5">
                    <Clock className="h-4 w-4 shrink-0 text-lime-400 mt-0.5" />
                    <span><strong>Today only:</strong> You only do today&apos;s exercise. Missed days lock at midnight to build daily discipline.</span>
                  </div>
                  <div className="flex items-start gap-2.5">
                    <Camera className="h-4 w-4 shrink-0 text-lime-400 mt-0.5" />
                    <span><strong>Handwritten uploads:</strong> Solve on real paper and upload photos of your working steps.</span>
                  </div>
                  <div className="flex items-start gap-2.5">
                    <Lock className="h-4 w-4 shrink-0 text-lime-400 mt-0.5" />
                    <span><strong>Topic-gated:</strong> No exercises appear for topics your tutor has not yet certified as complete.</span>
                  </div>
                </div>
              </div>

              <div className="mt-6 pt-4 border-t border-white/10 text-xs font-semibold text-lime-400 flex items-center justify-between">
                <span>Core Practice Habit</span>
                <span>Active Retention</span>
              </div>
            </div>

            {/* Pillar 2: 20% Peer Review */}
            <div className="group relative rounded-3xl border border-white/10 bg-slate-900/70 p-6 shadow-xl backdrop-blur transition-all duration-300 hover:-translate-y-2 hover:border-emerald-400/40 hover:shadow-2xl flex flex-col justify-between">
              <div>
                <div className="relative mb-6 overflow-hidden rounded-2xl border border-white/10 aspect-video">
                  <img
                    src={peerMarkingImg}
                    alt="Peer Review and Marking"
                    className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                  />
                  <div className="absolute top-3 left-3 rounded-full bg-emerald-400 px-3 py-1 text-xs font-black text-slate-950 shadow-md">
                    20% Evaluation
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-400/20 text-emerald-400">
                    <FileCheck2 className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold text-white">20% Peer Marking</h3>
                    <p className="text-xs text-emerald-400 font-semibold">Diagnostic Reinforcement</p>
                  </div>
                </div>

                <p className="mt-4 text-sm leading-relaxed text-slate-300">
                  After submitting your work, you are assigned an anonymous peer&apos;s uploaded handwritten answer image to mark using the official guideline.
                </p>

                <div className="mt-5 space-y-3 rounded-2xl border border-white/5 bg-slate-950/60 p-4 text-xs text-slate-300">
                  <div className="flex items-start gap-2.5">
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400 mt-0.5" />
                    <span><strong>Examiner&apos;s eye:</strong> Understand exactly how markers allocate method (M) and accuracy (A) marks.</span>
                  </div>
                  <div className="flex items-start gap-2.5">
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400 mt-0.5" />
                    <span><strong>Error spotting:</strong> Identifying errors in other submissions prevents you from repeating them in exams.</span>
                  </div>
                  <div className="flex items-start gap-2.5">
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400 mt-0.5" />
                    <span><strong>Double-blind review:</strong> Submissions remain anonymous to keep reviews honest and objective.</span>
                  </div>
                </div>
              </div>

              <div className="mt-6 pt-4 border-t border-white/10 text-xs font-semibold text-emerald-400 flex items-center justify-between">
                <span>Critical Assessment</span>
                <span>Deep Discernment</span>
              </div>
            </div>

            {/* Pillar 3: 10% Tutor Guidance */}
            <div className="group relative rounded-3xl border border-white/10 bg-slate-900/70 p-6 shadow-xl backdrop-blur transition-all duration-300 hover:-translate-y-2 hover:border-lime-400/40 hover:shadow-2xl flex flex-col justify-between">
              <div>
                <div className="relative mb-6 overflow-hidden rounded-2xl border border-white/10 aspect-video bg-gradient-to-br from-slate-950 to-slate-900 flex items-center justify-center p-6 text-center">
                  <div className="space-y-2">
                    <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-lime-400/20 text-lime-400 ring-2 ring-lime-400/30">
                      <GraduationCap className="h-8 w-8" />
                    </div>
                    <p className="text-xs font-mono text-lime-300">1 Tutor : 1 Student</p>
                    <p className="text-sm font-bold text-white">Personalized Direction</p>
                  </div>
                  <div className="absolute top-3 left-3 rounded-full bg-slate-800 border border-white/20 px-3 py-1 text-xs font-bold text-slate-200">
                    10% Strategy
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-lime-400/20 text-lime-400">
                    <ShieldCheck className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold text-white">10% Tutor Guidance</h3>
                    <p className="text-xs text-lime-400 font-semibold">Strategic Roadmap</p>
                  </div>
                </div>

                <p className="mt-4 text-sm leading-relaxed text-slate-300">
                  Every student has one dedicated Maths tutor who conducts 1-on-1 tutoring sessions, manages syllabus pace, and verifies topic mastery.
                </p>

                <div className="mt-5 space-y-3 rounded-2xl border border-white/5 bg-slate-950/60 p-4 text-xs text-slate-300">
                  <div className="flex items-start gap-2.5">
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-lime-400 mt-0.5" />
                    <span><strong>One tutor per student:</strong> Consistent guidance from an expert who knows your unique weak spots.</span>
                  </div>
                  <div className="flex items-start gap-2.5">
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-lime-400 mt-0.5" />
                    <span><strong>Topic verification:</strong> Your tutor certifies syllabus topics as mastered before exercises unlock.</span>
                  </div>
                  <div className="flex items-start gap-2.5">
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-lime-400 mt-0.5" />
                    <span><strong>Diagnostic progress:</strong> Continuous reports track your accuracy, completion rate, and exam readiness.</span>
                  </div>
                </div>
              </div>

              <div className="mt-6 pt-4 border-t border-white/10 text-xs font-semibold text-lime-400 flex items-center justify-between">
                <span>The Master Compass</span>
                <span>Targeted Coaching</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ================= 4-STEP WORKFLOW IN THE APP ================= */}
      <section className="relative mx-auto max-w-7xl px-4 py-20 lg:px-6">
        <div className="mx-auto max-w-3xl text-center space-y-3">
          <div className="inline-flex items-center gap-2 rounded-full border border-lime-400/30 bg-lime-400/10 px-3.5 py-1 text-xs font-bold uppercase tracking-[0.2em] text-lime-300">
            Student Journey
          </div>
          <h2 className="text-3xl font-black tracking-tight text-white md:text-5xl">
            How it works step by step
          </h2>
          <p className="text-slate-300 text-base sm:text-lg">
            A simple daily cycle designed for maximum mathematical growth.
          </p>
        </div>

        <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              step: '01',
              title: 'Learn with Your Tutor',
              desc: 'Meet your dedicated Maths tutor for 1-on-1 sessions. Once a topic is mastered, your tutor confirms it in the app.',
              icon: GraduationCap,
            },
            {
              step: '02',
              title: 'Today’s Exercises Unlock',
              desc: 'Daily problems unlock automatically from your tutor-confirmed topics. You must complete today’s exercise before midnight.',
              icon: BookOpen,
            },
            {
              step: '03',
              title: 'Solve on Paper & Upload',
              desc: 'Work out the problem step-by-step with pen and paper, then snap a clear photo and submit your answer image.',
              icon: Camera,
            },
            {
              step: '04',
              title: 'Mark for Others',
              desc: 'Grade an anonymous peer’s submission against the official memo, reinforcing your own knowledge and exam technique.',
              icon: Users,
            },
          ].map((st) => {
            const Icon = st.icon;
            return (
              <div
                key={st.step}
                className="relative rounded-3xl border border-white/10 bg-slate-900/70 p-6 backdrop-blur transition-all duration-300 hover:border-lime-400/40 hover:-translate-y-1"
              >
                <div className="flex items-center justify-between">
                  <span className="text-3xl font-black text-lime-400/40">{st.step}</span>
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-lime-400/10 text-lime-400">
                    <Icon className="h-4 w-4" />
                  </div>
                </div>
                <h4 className="mt-4 text-lg font-bold text-white">{st.title}</h4>
                <p className="mt-2 text-sm text-slate-400 leading-relaxed">{st.desc}</p>
              </div>
            );
          })}
        </div>
      </section>

      <section ref={pricingSectionRef} id="subscription-pricing" className="scroll-mt-6 border-y border-lime-500/20 bg-slate-900/40 py-20">
        <div className="mx-auto max-w-7xl px-4 lg:px-6">
          <SubscriptionPlanSelector
            onContinue={continueFromPricing}
            mobileSwipe
            allowDiscountInput
            initialDiscountCode={initialDiscountCode}
            studentId={profile?.role === 'student' ? profile.uid : null}
            initialSelection={{
              planId: linkSelection.get('planId') || 'circle',
              billingPeriod: linkSelection.get('billingPeriod') || 'monthly',
              subjectCount: linkSelection.get('subjectCount') || 1,
            }}
          />
        </div>
      </section>

      {/* ================= FINAL CALL TO ACTION ================= */}
      <section className="relative mx-auto max-w-7xl px-4 py-16 lg:px-6">
        <div className="relative overflow-hidden rounded-3xl border-2 border-lime-400/40 bg-gradient-to-br from-slate-900 via-slate-950 to-slate-900 p-8 sm:p-12 md:p-16 text-center shadow-[0_0_80px_rgba(163,230,53,0.15)]">
          <div className="pointer-events-none absolute -top-24 left-1/2 -z-10 h-[400px] w-[600px] -translate-x-1/2 rounded-full bg-lime-400/20 blur-3xl" />

          <div className="mx-auto max-w-3xl space-y-6">
            <div className="inline-flex items-center gap-2 rounded-full border border-lime-400/40 bg-lime-400/10 px-4 py-1.5 text-xs font-bold uppercase tracking-[0.2em] text-lime-300">
              Start Your Daily Practice
            </div>

            <h2 className="text-3xl font-black tracking-tight text-white md:text-5xl lg:text-6xl">
              Consistent daily practice starts today.
            </h2>

            <p className="text-base sm:text-lg text-slate-300 leading-relaxed">
              Connect with your dedicated Maths tutor, unlock daily focused exercises as you master each topic, and build unshakable exam readiness.
            </p>

            <div className="pt-4 flex flex-wrap justify-center gap-4">
              <Link
                to={signupPath}
                className="inline-flex items-center gap-2.5 rounded-full bg-gradient-to-r from-lime-400 via-lime-300 to-emerald-400 px-8 py-3.5 text-base font-extrabold text-slate-950 shadow-[0_0_35px_rgba(163,230,53,0.5)] transition hover:scale-105 hover:shadow-[0_0_50px_rgba(163,230,53,0.7)]"
              >
                <span>Get started with Examifying</span>
                <ArrowRight className="h-5 w-5" />
              </Link>
              <Link
                to={loginPath}
                className="inline-flex items-center gap-2 rounded-full border border-lime-400/30 bg-slate-900/80 px-7 py-3.5 text-sm font-semibold text-lime-300 transition hover:border-lime-400 hover:bg-lime-400/10 hover:text-white"
              >
                Sign in to your account
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ================= DARK THEME LEMON-LIME FOOTER ================= */}
      <footer className="relative border-t border-lime-500/20 bg-slate-950">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(163,230,53,0.08),transparent_60%)]" />

        <div className="relative mx-auto max-w-7xl px-4 py-14 lg:px-6 grid gap-10 md:grid-cols-4">
          <div className="md:col-span-2 space-y-3">
            <div className="flex items-center gap-3">
              <img src="/logo.png" alt="" className="h-10 w-10 shrink-0 object-contain drop-shadow-md" />
              <div>
                <span className="flex items-center gap-2 bg-gradient-to-r from-lime-400 via-lime-300 to-emerald-400 bg-clip-text text-xl font-black tracking-tight text-transparent">
                  Examifying
                  <span className="rounded bg-lime-400/15 border border-lime-400/30 px-1.5 py-0.5 text-[10px] font-bold text-lime-400 uppercase tracking-widest">
                    Maths
                  </span>
                </span>
              </div>
            </div>
            <p className="max-w-md text-sm text-slate-400 leading-relaxed">
              Structured daily Mathematics learning for South African high school students, powered by the 70-20-10 methodology, dedicated tutors, and peer marking.
            </p>
          </div>

          <div>
            <p className="font-bold text-white text-sm tracking-wider uppercase">Policies</p>
            <ul className="mt-3 space-y-2 text-sm text-slate-400">
              <li>
                <Link to="/policies#terms" className="hover:text-lime-400 transition-colors flex items-center gap-1">
                  Terms of Use <ArrowUpRight className="h-3 w-3" />
                </Link>
              </li>
              <li>
                <Link to="/policies#privacy" className="hover:text-lime-400 transition-colors flex items-center gap-1">
                  Privacy Policy <ArrowUpRight className="h-3 w-3" />
                </Link>
              </li>
              <li>
                <Link to="/policies#refunds" className="hover:text-lime-400 transition-colors flex items-center gap-1">
                  Refund Policy <ArrowUpRight className="h-3 w-3" />
                </Link>
              </li>
              <li>
                <Link to="/policies#contact" className="hover:text-lime-400 transition-colors flex items-center gap-1">
                  Contact Info <ArrowUpRight className="h-3 w-3" />
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <p className="font-bold text-white text-sm tracking-wider uppercase">Contact</p>
            <ul className="mt-3 space-y-2 text-sm text-slate-400">
              <li className="text-slate-300">
                <span className="block text-xs text-slate-500 uppercase">Email</span>
                bakayise.developers@gmail.com
              </li>
              <li className="text-slate-300">
                <span className="block text-xs text-slate-500 uppercase">Region</span>
                South Africa
              </li>
            </ul>
          </div>
        </div>

        <div className="relative border-t border-white/10 py-5 text-center text-xs text-slate-500">
          <div className="mx-auto max-w-7xl px-4 flex flex-col sm:flex-row items-center justify-between gap-2">
            <span>© {new Date().getFullYear()} Examifying. All rights reserved.</span>
            <span className="text-slate-400">70 - 20 - 10 Mathematics Learning</span>
          </div>
        </div>
      </footer>
    </div>
  );
};
