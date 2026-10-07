import { CheckCircle2, ChevronRight, Trophy } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '../components/common/AppShell';
import { SectionHeader } from '../components/common/SectionHeader';
import { guideContentByRole } from '../data/guideContent';
import { useAuth } from '../hooks/useAuth';
import { getLatestGuideQuizResult, saveGuideQuizResult } from '../services/firestoreService';
import { useEffectiveRole } from '../utils/effectiveRole';
import { useOperationStatus } from '../hooks/useOperationStatus';

const routeBaseByRole = {
  student: '/student',
  tutor: '/tutor',
  teacher: '/teacher',
};

export const GuidePage = ({ role: propRole }) => {
  const { profile, logout } = useAuth();
  const { runOperation } = useOperationStatus();
  const { role: userRole } = useEffectiveRole();
  const role = propRole || userRole;
  const guideRoleKey = role === 'teacher' ? 'teacher' : (role === 'tutor' ? 'tutor' : 'student');
  const content = guideContentByRole[guideRoleKey] ?? guideContentByRole.tutor;
  const [answers, setAnswers] = useState({});
  const [status, setStatus] = useState('');
  const [latestResult, setLatestResult] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const loadLatestResult = async () => {
      if (!profile?.uid || !role) return;
      const result = await getLatestGuideQuizResult({ userId: profile.uid, role });
      setLatestResult(result);
    };

    loadLatestResult();
  }, [profile?.uid, role]);

  const totalQuestions = content.questions.length;
  const answeredCount = useMemo(
    () => content.questions.filter((question) => answers[question.id]).length,
    [answers, content.questions],
  );

  const handleSelect = (questionId, optionId) => {
    setAnswers((current) => ({ ...current, [questionId]: optionId }));
  };

  const handleSubmit = async () => {
    if (answeredCount !== totalQuestions) {
      setStatus('Please answer every question before submitting your guide test.');
      return;
    }

    setIsSubmitting(true);
    setStatus('');

    try {
      const score = content.questions.reduce((sum, question) => {
        const selected = answers[question.id];
        const isCorrect = question.options.some((option) => option.id === selected && option.correct);
        return sum + (isCorrect ? 1 : 0);
      }, 0);
      const percentage = Math.round((score / totalQuestions) * 100);

      const payload = {
        userId: profile?.uid,
        role,
        userName: profile?.displayName || profile?.email || (role === 'student' ? 'Student' : 'Tutor'),
        answers,
        score,
        totalQuestions,
        percentage,
      };

      const result = await runOperation({ operationName: 'Saving guide results', successMessage: 'Your guide result has been saved.' }, () => saveGuideQuizResult(payload));
      setLatestResult(result);
      setStatus(`Guide test saved successfully. Your latest mark is ${percentage}%.`);
    } catch (error) {
      console.error('[Examifying][GuidePage] submit:error', error);
      setStatus(error?.message || 'Unable to save your guide test right now.');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!content) return null;

  return (
    <AppShell
      title="Examifying Guide"
      subtitle={content.heroDescription}
      role={role}
      user={profile}
      onLogout={logout}
    >
      <section className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="panel p-6 md:p-8">
          <p className="text-sm font-semibold uppercase tracking-[0.25em] text-brand-700">Guided onboarding</p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-950">{content.heroTitle}</h2>
          <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-600">{content.heroDescription}</p>

          <div className="mt-6 grid gap-3 md:grid-cols-2">
            {content.quickTips.map((tip) => (
              <div key={tip} className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-700">
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-600" />
                  <span>{tip}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="panel p-6 md:p-8">
          <div className="flex items-center gap-3 text-brand-700">
            <Trophy className="h-5 w-5" />
            <p className="font-semibold">Guide completion</p>
          </div>
          <div className="mt-5 space-y-4 text-sm text-slate-600">
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-xs uppercase tracking-[0.25em] text-slate-500">Questions answered</p>
              <p className="mt-2 text-3xl font-bold text-slate-950">{answeredCount}/{totalQuestions}</p>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-xs uppercase tracking-[0.25em] text-slate-500">Latest saved mark</p>
              <p className="mt-2 text-3xl font-bold text-slate-950">{latestResult ? `${latestResult.percentage}%` : 'Not submitted yet'}</p>
              {latestResult ? (
                <p className="mt-2 text-sm text-slate-500">
                  Score: {latestResult.score}/{latestResult.totalQuestions}
                </p>
              ) : null}
            </div>
            <div className="rounded-2xl border border-dashed border-slate-300 p-4">
              <p className="font-semibold text-slate-900">What gets saved</p>
              <p className="mt-2">Your answers, score, percentage, role, and submission time are stored when you press submit.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="space-y-6">
        <SectionHeader
          eyebrow="How to use Examifying"
          title="Follow the same steps you see in the app"
          description="Use these visual guides to understand where to click, what to expect, and how the normal workflow should move from one page to the next."
        />

        <div className="grid gap-5 lg:grid-cols-2">
          {content.sections.map((section, index) => {
            const Icon = section.icon;
            return (
              <article key={section.id} className="panel p-6">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div className="rounded-2xl bg-brand-50 p-3 text-brand-700">
                      <Icon className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-[0.25em] text-slate-500">Step {index + 1}</p>
                      <h3 className="mt-1 text-xl font-semibold text-slate-950">{section.title}</h3>
                    </div>
                  </div>
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-slate-600">
                    {section.routeLabel}
                  </span>
                </div>
                <p className="mt-4 text-sm leading-7 text-slate-600">{section.description}</p>
                <div className="mt-5 space-y-3">
                  {section.steps.map((step) => (
                    <div key={step} className="flex gap-3 rounded-2xl bg-slate-50 p-4 text-sm text-slate-700">
                      <ChevronRight className="mt-0.5 h-4 w-4 flex-none text-brand-600" />
                      <span>{step}</span>
                    </div>
                  ))}
                </div>
                <Link
                  to={routeBaseByRole[role]}
                  className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-brand-700"
                >
                  Open {role} workspace
                  <ChevronRight className="h-4 w-4" />
                </Link>
              </article>
            );
          })}
        </div>
      </section>

      <section className="panel p-6 md:p-8">
        <SectionHeader
          eyebrow="Knowledge check"
          title={content.quizTitle}
          description={content.quizDescription}
        />

        <div className="mt-6 space-y-6">
          {content.questions.map((question, index) => (
            <div key={question.id} className="rounded-3xl border border-slate-800 bg-slate-900/60 p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.25em] text-lime-400">Question {index + 1}</p>
              <h3 className="mt-2 text-lg font-semibold text-white">{question.prompt}</h3>
              <div className="mt-4 grid gap-3">
                {question.options.map((option) => {
                  const selected = answers[question.id] === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => handleSelect(question.id, option.id)}
                      className={`rounded-2xl border px-4 py-3 text-left text-sm transition ${
                        selected
                          ? 'border-lime-400 bg-lime-400/20 text-lime-300 font-semibold shadow-[0_0_15px_rgba(163,230,53,0.15)]'
                          : 'border-slate-800 bg-slate-950 text-slate-300 hover:border-lime-400/40 hover:bg-slate-900'
                      }`}
                    >
                      {option.text}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="text-sm text-slate-500">
            Submit after all questions are answered so your latest percentage can be saved for review.
          </div>
          <button type="button" className="btn-primary" disabled={isSubmitting} onClick={handleSubmit}>
            {isSubmitting ? 'Saving guide test...' : 'Submit guide test'}
          </button>
        </div>

        {status ? (
          <div className="mt-5 rounded-2xl bg-slate-50 p-4 text-sm text-slate-700">{status}</div>
        ) : null}
      </section>
    </AppShell>
  );
};
