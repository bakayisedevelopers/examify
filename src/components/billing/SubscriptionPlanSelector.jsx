import { BookOpen, Check, Minus, Plus, Users, UserRound } from 'lucide-react';
import { useState } from 'react';
import { calculateSubscriptionQuote } from '../../utils/subscriptionPlans';

const plans = {
  free: { name: 'Free', category: 'Question papers', icon: BookOpen },
  circle: { name: 'Circle', category: 'Group', icon: Users },
  personalized: { name: 'Personalized', category: 'One-on-one + group', icon: UserRound },
};

const formatRand = (amount) => `R${amount.toLocaleString('en-ZA', { maximumFractionDigits: 2 })}`;

export const SubscriptionPlanSelector = ({ onContinue, isSubmitting = false, initialSelection = {} }) => {
  const [planId, setPlanId] = useState(plans[initialSelection.planId] ? initialSelection.planId : 'circle');
  const [billingPeriod, setBillingPeriod] = useState(initialSelection.billingPeriod === 'yearly' ? 'yearly' : 'monthly');
  const [subjectCount, setSubjectCount] = useState(Math.max(1, Math.min(20, Number(initialSelection.subjectCount) || 1)));
  const quote = calculateSubscriptionQuote({ planId, billingPeriod, subjectCount });
  const billingPeriodLabel = billingPeriod === 'yearly' ? 'year' : 'month';

  const selectPlan = (nextPlan) => setPlanId(nextPlan);

  return (
    <section className="space-y-5" aria-labelledby="subscription-plans-heading">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-lime-400">Subscriptions</p>
          <h2 id="subscription-plans-heading" className="mt-1 text-2xl font-bold tracking-tight text-white">Choose your plan</h2>
          <p className="mt-2 text-sm text-slate-400">Annual subscriptions receive two months free.</p>
        </div>
        <div className="flex items-center gap-2" role="group" aria-label="Billing period">
          <button type="button" onClick={() => setBillingPeriod('monthly')} aria-pressed={billingPeriod === 'monthly'} className={billingPeriod === 'monthly' ? 'btn-primary' : 'btn-secondary'}>Monthly</button>
          <button type="button" onClick={() => setBillingPeriod('yearly')} aria-pressed={billingPeriod === 'yearly'} className={billingPeriod === 'yearly' ? 'btn-primary' : 'btn-secondary'}>Yearly · 2 months free</button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {Object.entries(plans).map(([id, plan]) => {
          const active = planId === id;
          const Icon = plan.icon;
          const planQuote = calculateSubscriptionQuote({ planId: id, billingPeriod, subjectCount });
          return (
            <article key={id} className={`panel flex flex-col p-5 transition-colors ${active ? 'border-lime-400/60 shadow-[0_0_24px_rgba(163,230,53,0.12)]' : 'hover:border-slate-600'}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${active ? 'bg-lime-400/15 text-lime-300' : 'bg-slate-800 text-slate-300'}`}>
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <div>
                    <h3 className="text-lg font-bold text-white">{plan.name}</h3>
                    <p className="mt-0.5 text-xs font-semibold text-lime-300">{plan.category}</p>
                  </div>
                </div>
                {active ? <Check className="h-5 w-5 text-lime-300" aria-label="Selected" /> : null}
              </div>

              <p className="mt-5 text-2xl font-bold text-white">
                {id === 'free' ? 'Free' : <>{formatRand(planQuote.amount)}<span className="text-sm font-normal text-slate-400"> / {billingPeriod === 'yearly' ? 'year' : 'month'}</span></>}
              </p>
              {billingPeriod === 'yearly' && id !== 'free' ? <p className="mt-1 text-xs text-slate-400">{formatRand(planQuote.monthlyAmount)} monthly · 2 months free</p> : null}

              {id === 'free' ? (
                <ul className="mt-3 min-h-[7rem] space-y-2 text-sm text-slate-300">
                  <li>Unlimited question papers across all available subjects</li>
                  <li>No Examifying Program or exercise generation</li>
                </ul>
              ) : id === 'circle' ? (
                <ul className="mt-3 min-h-[7rem] space-y-2 text-sm text-slate-300">
                  <li>{planQuote.groupLessonsPerSubject} group lessons per subject in each subscription period ({planQuote.groupLessonsPerWindow} total)</li>
                  <li>Examifying Program access for each registered subject</li>
                  <li>1 subject included; {formatRand(planQuote.additionalSubjectAmountForPeriod)} per additional subject/{billingPeriodLabel}</li>
                </ul>
              ) : (
                <ul className="mt-3 min-h-[7rem] space-y-2 text-sm text-slate-300">
                  <li>{planQuote.oneOnOneLessonsPerSubject} one-on-one lessons per subject in each subscription period ({planQuote.oneOnOneLessonsPerWindow} total)</li>
                  <li>{planQuote.groupLessonsPerSubject} group lessons per subject in each subscription period ({planQuote.groupLessonsPerWindow} total)</li>
                  <li>Examifying Program access for each registered subject</li>
                  <li>1 subject included; {formatRand(planQuote.additionalSubjectAmountForPeriod)} per additional subject/{billingPeriodLabel}</li>
                </ul>
              )}

              <button type="button" onClick={() => selectPlan(id)} aria-pressed={active} className={`mt-5 w-full ${active ? 'btn-primary' : 'btn-secondary'}`}>
                {active ? 'Selected' : 'Select plan'}
              </button>
            </article>
          );
        })}
      </div>

      {planId !== 'free' ? (
        <div className="panel flex flex-wrap items-center justify-between gap-5 p-5">
          <div>
            <p className="text-sm font-semibold text-white">Registered subjects</p>
            <p className="mt-1 text-xs text-slate-400">Choose 1 to 20 subjects. The first subject is included in the plan price.</p>
          </div>
          <div className="flex items-center gap-3">
            <button type="button" className="btn-secondary h-11 w-11 p-0" onClick={() => setSubjectCount((count) => Math.max(1, count - 1))} aria-label="Remove one subject" disabled={subjectCount <= 1}>
              <Minus className="h-4 w-4" aria-hidden="true" />
            </button>
            <input type="number" min="1" max="20" step="1" className="input w-24 text-center" value={subjectCount} onChange={(event) => setSubjectCount(Math.max(1, Math.min(20, Math.floor(Number(event.target.value) || 1))))} aria-label="Number of registered subjects" />
            <button type="button" className="btn-secondary h-11 w-11 p-0" onClick={() => setSubjectCount((count) => Math.min(20, count + 1))} aria-label="Add one subject" disabled={subjectCount >= 20}>
              <Plus className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-end justify-between gap-4 border-t border-slate-800 pt-5">
        <div>
          <p className="text-sm text-slate-400">{billingPeriod === 'yearly' && planId !== 'free' ? 'Annual total' : 'Monthly total'}</p>
          <p className="mt-1 text-3xl font-bold text-white">{formatRand(quote.amount)}</p>
          {billingPeriod === 'yearly' && planId !== 'free' ? <p className="mt-1 text-sm text-slate-400">{formatRand(quote.amount / 12)} per month equivalent · billed yearly</p> : null}
          {quote.additionalSubjects > 0 ? <p className="mt-1 text-sm text-slate-400">Includes {quote.additionalSubjects} additional {quote.additionalSubjects === 1 ? 'subject' : 'subjects'}.</p> : null}
          {planId !== 'free' ? <p className="mt-1 text-sm text-slate-400">{quote.sessionsPerWindow} total lessons in this subscription period</p> : null}
        </div>
        <button type="button" className="btn-primary min-w-40" onClick={() => onContinue?.({ planId, billingPeriod, subjectCount: quote.subjectCount, quote })} disabled={isSubmitting || !onContinue}>
          {isSubmitting ? 'Please wait...' : planId === 'free' ? 'Continue with Free' : 'Continue'}
        </button>
      </div>
    </section>
  );
};
