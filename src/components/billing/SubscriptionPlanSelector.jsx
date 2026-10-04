import { BookOpen, Check, Minus, Plus, Users, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { calculateSubscriptionQuote } from '../../utils/subscriptionPlans';
import { validateDiscountCode } from '../../services/discountCodesService';

const plans = {
  free: { name: 'Free', category: 'Question papers', icon: BookOpen },
  circle: { name: 'Circle', category: 'Group', icon: Users },
  personalized: { name: 'Personalized', category: 'One-on-one + group', icon: UserRound },
};

const formatRand = (amount) => `R${amount.toLocaleString('en-ZA', { maximumFractionDigits: 2 })}`;

export const SubscriptionPlanSelector = ({
  onContinue,
  isSubmitting = false,
  initialSelection = {},
  mobileSwipe = false,
  studentId = null,
  initialDiscountCode = '',
  allowDiscountInput = false,
}) => {
  const [planId, setPlanId] = useState(plans[initialSelection.planId] ? initialSelection.planId : 'circle');
  const [billingPeriod, setBillingPeriod] = useState(initialSelection.billingPeriod === 'yearly' ? 'yearly' : 'monthly');
  const [subjectCount, setSubjectCount] = useState(Math.max(1, Math.min(20, Number(initialSelection.subjectCount) || 1)));
  const [discountCode, setDiscountCode] = useState(String(initialDiscountCode || '').toUpperCase());
  const [discountQuote, setDiscountQuote] = useState(null);
  const [validatedSelectionKey, setValidatedSelectionKey] = useState('');
  const [discountStatus, setDiscountStatus] = useState('');
  const [isValidatingDiscount, setIsValidatingDiscount] = useState(false);
  const quote = calculateSubscriptionQuote({ planId, billingPeriod, subjectCount });
  const billingPeriodLabel = billingPeriod === 'yearly' ? 'year' : 'month';
  const selectionKey = `${planId}|${billingPeriod}|${quote.subjectCount}`;
  const activeDiscountQuote = validatedSelectionKey === selectionKey ? discountQuote : null;

  useEffect(() => {
    setDiscountQuote(null);
    setValidatedSelectionKey('');
    setDiscountStatus('');
  }, [selectionKey]);

  const validateEnteredCode = async (candidate = discountCode) => {
    const normalizedCode = String(candidate ?? '').trim().toUpperCase();
    if (!normalizedCode) {
      setDiscountQuote(null);
      setValidatedSelectionKey('');
      setDiscountStatus('Enter a discount code first.');
      return;
    }
    if (!studentId) {
      setDiscountStatus('Your code will be checked securely after you create an account or sign in.');
      return;
    }
    setIsValidatingDiscount(true);
    setDiscountStatus('Checking discount code…');
    setDiscountQuote(null);
    setValidatedSelectionKey('');
    try {
      const result = await validateDiscountCode({
        studentId,
        planId,
        billingPeriod,
        subjectCount: quote.subjectCount,
        code: normalizedCode,
      });
      setDiscountQuote(result);
      setValidatedSelectionKey(selectionKey);
      setDiscountCode(normalizedCode);
      setDiscountStatus(`${result.percentOff}% discount applied to ${result.billingDuration === 'recurring' ? 'this and future eligible renewals' : 'the first payment'}.`);
    } catch (error) {
      setDiscountStatus(error?.message || 'This discount code could not be validated.');
    } finally {
      setIsValidatingDiscount(false);
    }
  };

  useEffect(() => {
    if (studentId && initialDiscountCode) validateEnteredCode(initialDiscountCode);
    // Initial signup codes should be validated once when the signed-in checkout opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studentId, initialDiscountCode]);

  const selectPlan = (nextPlan) => setPlanId(nextPlan);

  return (
    <section className="space-y-5" aria-labelledby="subscription-plans-heading">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-lime-400">Subscriptions</p>
          <h2 id="subscription-plans-heading" className="mt-1 text-2xl font-bold tracking-tight text-white">Choose your plan</h2>
          <p className="mt-2 hidden text-sm text-slate-400">Annual subscriptions receive two months free.</p>
          {mobileSwipe ? <p className="mt-2 text-xs text-slate-400 lg:hidden">Swipe left or right to compare plans.</p> : null}
        </div>
        <div className="flex items-center gap-2" role="group" aria-label="Billing period">
          <button type="button" onClick={() => setBillingPeriod('monthly')} aria-pressed={billingPeriod === 'monthly'} className={billingPeriod === 'monthly' ? 'btn-primary' : 'btn-secondary'}>Monthly</button>
          <button type="button" onClick={() => setBillingPeriod('yearly')} aria-pressed={billingPeriod === 'yearly'} className={`hidden ${billingPeriod === 'yearly' ? 'btn-primary' : 'btn-secondary'}`}>Yearly · 2 months free</button>
        </div>
      </div>

      <div className={mobileSwipe
        ? 'flex snap-x snap-mandatory gap-4 overflow-x-auto overscroll-x-contain scroll-smooth pb-3 lg:grid lg:grid-cols-3 lg:overflow-visible lg:pb-0'
        : 'grid gap-4 lg:grid-cols-3'}>
        {Object.entries(plans).map(([id, plan]) => {
          const active = planId === id;
          const Icon = plan.icon;
          const planQuote = calculateSubscriptionQuote({ planId: id, billingPeriod, subjectCount });
          return (
            <article key={id} className={`panel flex flex-col p-5 transition-colors ${mobileSwipe ? 'basis-[88%] shrink-0 snap-center sm:basis-[76%] lg:basis-auto' : ''} ${active ? 'border-lime-400/60 shadow-[0_0_24px_rgba(163,230,53,0.12)]' : 'hover:border-slate-600'}`}>
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

      <div className="panel flex flex-wrap items-center justify-between gap-5 p-5">
          <div>
            <p className="text-sm font-semibold text-white">Number of subjects</p>
            <p className="mt-1 text-xs text-slate-400">{planId === 'free' ? 'Free includes 0 registered subjects. Choose Circle or Personalized to select subjects.' : 'Choose 1 to 20 subjects. The first subject is included in the plan price.'}</p>
          </div>
          <div className="flex items-center gap-3">
            <button type="button" className="btn-secondary h-11 w-11 p-0" onClick={() => setSubjectCount((count) => Math.max(1, count - 1))} aria-label="Remove one subject" disabled={planId === 'free' || subjectCount <= 1}>
              <Minus className="h-4 w-4" aria-hidden="true" />
            </button>
            <input type="number" min={planId === 'free' ? '0' : '1'} max={planId === 'free' ? '0' : '20'} step="1" className="input w-24 text-center" value={planId === 'free' ? 0 : subjectCount} disabled={planId === 'free'} onChange={(event) => setSubjectCount(Math.max(1, Math.min(20, Math.floor(Number(event.target.value) || 1))))} aria-label="Number of registered subjects" />
            <button type="button" className="btn-secondary h-11 w-11 p-0" onClick={() => setSubjectCount((count) => Math.min(20, count + 1))} aria-label="Add one subject" disabled={planId === 'free' || subjectCount >= 20}>
              <Plus className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
      </div>

      {(studentId || allowDiscountInput) ? (
        <div className="panel space-y-3 p-5">
          <label className="block max-w-xl">
            <span className="text-sm font-semibold text-white">Discount code</span>
            <span className="mt-1 block text-xs text-slate-400">{studentId ? 'We verify eligibility and pricing on the server before checkout.' : 'Your code is validated after account creation or sign-in.'}</span>
            <div className="mt-3 flex flex-wrap gap-2">
              <input
                className="input min-w-[12rem] flex-1 font-mono uppercase tracking-wider"
                autoComplete="off"
                value={discountCode}
                onChange={(event) => {
                  setDiscountCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''));
                  setDiscountQuote(null);
                  setValidatedSelectionKey('');
                  setDiscountStatus('');
                }}
                placeholder="Enter code"
                aria-label="Discount code"
              />
              {studentId ? <button type="button" className="btn-secondary" disabled={isValidatingDiscount || !discountCode.trim()} onClick={() => validateEnteredCode()}>{isValidatingDiscount ? 'Checking…' : 'Apply code'}</button> : null}
            </div>
          </label>
          {discountStatus ? <p role="status" className={`text-sm ${activeDiscountQuote ? 'text-lime-300' : 'text-slate-300'}`}>{discountStatus}</p> : null}
          {activeDiscountQuote ? (
            <div className="max-w-xl rounded-xl border border-lime-400/30 bg-lime-400/5 p-4 text-sm">
              <p className="flex justify-between gap-4 text-slate-300"><span>Original price</span><span>{formatRand(activeDiscountQuote.originalAmount)}</span></p>
              <p className="mt-2 flex justify-between gap-4 text-lime-300"><span>{activeDiscountQuote.percentOff}% discount</span><span>−{formatRand(activeDiscountQuote.discountAmount)}</span></p>
              <p className="mt-2 flex justify-between gap-4 border-t border-slate-700 pt-2 font-bold text-white"><span>Due now</span><span>{formatRand(activeDiscountQuote.finalAmount)}</span></p>
              {activeDiscountQuote.billingDuration === 'recurring' ? <p className="mt-2 text-xs text-slate-400">Discount continues on eligible renewals for this plan selection.</p> : <p className="mt-2 text-xs text-slate-400">Discount applies to the first payment only.</p>}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-end justify-between gap-4 border-t border-slate-800 pt-5">
        <div>
          <p className="text-sm text-slate-400">{billingPeriod === 'yearly' && planId !== 'free' ? 'Annual total' : 'Monthly total'}</p>
          <p className="mt-1 text-3xl font-bold text-white">{formatRand(activeDiscountQuote?.finalAmount ?? quote.amount)}</p>
          {activeDiscountQuote ? <p className="mt-1 text-sm text-slate-400">Original {formatRand(activeDiscountQuote.originalAmount)} · save {formatRand(activeDiscountQuote.discountAmount)}</p> : null}
          {billingPeriod === 'yearly' && planId !== 'free' ? <p className="mt-1 text-sm text-slate-400">{formatRand(quote.amount / 12)} per month equivalent · billed yearly</p> : null}
          {quote.additionalSubjects > 0 ? <p className="mt-1 text-sm text-slate-400">Includes {quote.additionalSubjects} additional {quote.additionalSubjects === 1 ? 'subject' : 'subjects'}.</p> : null}
          {planId !== 'free' ? <p className="mt-1 text-sm text-slate-400">{quote.sessionsPerWindow} total lessons in this subscription period</p> : null}
        </div>
        <button type="button" className="btn-primary min-w-40" onClick={() => onContinue?.({
          planId, billingPeriod, subjectCount: quote.subjectCount, quote,
          ...(activeDiscountQuote ? { discountCode: activeDiscountQuote.code } : {}),
          ...(!studentId && allowDiscountInput && discountCode.trim() ? { discountCode: discountCode.trim().toUpperCase() } : {}),
        })} disabled={isSubmitting || !onContinue || (studentId && Boolean(discountCode.trim()) && !activeDiscountQuote) || isValidatingDiscount}>
          {isSubmitting ? 'Please wait...' : planId === 'free' ? 'Continue with Free' : 'Continue'}
        </button>
      </div>
    </section>
  );
};
