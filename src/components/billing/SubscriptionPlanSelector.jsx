import { Check, Users, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { calculateSubscriptionQuote } from '../../utils/subscriptionPlans';
import { previewDiscountCode, validateDiscountCode } from '../../services/discountCodesService';

const paidPlans = [
  { id: 'circle', name: 'Circle', category: 'Group', icon: Users },
  { id: 'personalized', name: 'Personalized', category: 'One-on-one + group', icon: UserRound },
];

const formatRand = (amount) => `R${amount.toLocaleString('en-ZA', { maximumFractionDigits: 2 })}`;
const normalizeSubjectCount = (value) => Math.max(1, Math.min(20, Math.floor(Number(value) || 1)));

const getDurationLabel = (quote) => {
  if (quote.billingDuration === 'fixed_months') {
    return `Discount applies for the first ${quote.discountDurationMonths} monthly billing periods after activation.`;
  }
  if (quote.billingDuration === 'recurring') return 'Discount continues on eligible renewals for this plan selection.';
  return 'Discount applies to the first payment only.';
};

const PlanCard = ({
  plan,
  billingPeriod,
  initialSubjectCount,
  selected,
  studentId,
  discountCode,
  mobileSwipe,
  isSubmitting,
  onSelect,
  onContinue,
}) => {
  const [subjectCountValue, setSubjectCountValue] = useState(String(normalizeSubjectCount(initialSubjectCount)));
  const [discountQuote, setDiscountQuote] = useState(null);
  const [validatedSelectionKey, setValidatedSelectionKey] = useState('');
  const [validatedCode, setValidatedCode] = useState('');
  const [discountStatus, setDiscountStatus] = useState('');
  const [isValidatingDiscount, setIsValidatingDiscount] = useState(false);

  const subjectCount = normalizeSubjectCount(subjectCountValue);
  const quote = calculateSubscriptionQuote({ planId: plan.id, billingPeriod, subjectCount });
  const selectionKey = `${plan.id}|${billingPeriod}|${quote.subjectCount}`;
  const activeDiscountQuote = validatedSelectionKey === selectionKey && validatedCode === discountCode
    ? discountQuote
    : null;

  useEffect(() => {
    let current = true;
    let timer = null;
    setDiscountQuote(null);
    setValidatedSelectionKey('');
    setValidatedCode('');
    setDiscountStatus('');
    setIsValidatingDiscount(false);

    if (discountCode.length !== 10) return () => { current = false; };

    setIsValidatingDiscount(true);
    setDiscountStatus('Checking discount…');
    timer = window.setTimeout(() => {
      const checkDiscount = studentId ? validateDiscountCode : previewDiscountCode;
      checkDiscount({
        studentId,
        planId: plan.id,
        billingPeriod,
        subjectCount: quote.subjectCount,
        code: discountCode,
      }).then((result) => {
        if (!current) return;
        setDiscountQuote(result);
        setValidatedSelectionKey(selectionKey);
        setValidatedCode(discountCode);
        setDiscountStatus('');
      }).catch((error) => {
        if (!current) return;
        setDiscountStatus(error?.message || 'This discount code could not be validated.');
      }).finally(() => {
        if (current) setIsValidatingDiscount(false);
      });
    }, 300);

    return () => {
      current = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [billingPeriod, discountCode, plan.id, quote.subjectCount, selectionKey, studentId]);

  const handleCardClick = (event) => {
    if (event.target.closest('button, input, select, textarea, a, label')) return;
    onSelect(plan.id);
  };

  const handleCardKeyDown = (event) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(plan.id);
    }
  };

  const handleSubjectCountChange = (event) => {
    const nextValue = event.target.value;
    if (nextValue === '') {
      setSubjectCountValue('');
      return;
    }
    if (/^\d{1,2}$/.test(nextValue)) setSubjectCountValue(String(normalizeSubjectCount(nextValue)));
  };

  return (
    <article
      className={`panel relative flex flex-col p-5 transition-colors ${mobileSwipe ? 'basis-[92%] shrink-0 snap-center sm:basis-[80%] lg:basis-auto' : ''} ${selected ? 'border-lime-400/60 shadow-[0_0_24px_rgba(163,230,53,0.12)]' : 'hover:border-slate-600'} cursor-pointer`}
      role="group"
      aria-label={`${plan.name} subscription card${selected ? ', selected' : ''}`}
      aria-current={selected ? 'true' : undefined}
      tabIndex={0}
      onClick={handleCardClick}
      onKeyDown={handleCardKeyDown}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${selected ? 'bg-lime-400/15 text-lime-300' : 'bg-slate-800 text-slate-300'}`}>
            <plan.icon className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h3 className="text-lg font-bold text-white">{plan.name}</h3>
            <p className="mt-0.5 text-xs font-semibold text-lime-300">{plan.category}</p>
          </div>
        </div>
        {selected ? <Check className="h-5 w-5 text-lime-300" aria-label="Selected" /> : null}
      </div>

      <div className="mt-5 min-h-[4.25rem]" aria-live="polite">
        {activeDiscountQuote ? (
          <>
            <p className="flex flex-wrap items-baseline gap-x-2 text-sm text-slate-400">
              <span>Original price</span>
              <del className="text-base">{formatRand(activeDiscountQuote.originalAmount)}</del>
            </p>
            <p className="mt-1 text-sm font-semibold text-lime-300">
              Save {formatRand(activeDiscountQuote.discountAmount)} ({activeDiscountQuote.percentOff}%)
            </p>
            <p className="mt-1 text-3xl font-extrabold text-white">
              {formatRand(activeDiscountQuote.finalAmount)}<span className="ml-1 text-sm font-normal text-slate-400">/ {billingPeriod === 'yearly' ? 'year' : 'month'}</span>
            </p>
            <p className="mt-1 text-xs text-slate-400">{getDurationLabel(activeDiscountQuote)}</p>
          </>
        ) : (
          <p className="text-3xl font-extrabold text-white">
            {formatRand(quote.amount)}<span className="ml-1 text-sm font-normal text-slate-400">/ {billingPeriod === 'yearly' ? 'year' : 'month'}</span>
          </p>
        )}
      </div>
      {selected && discountStatus ? <p role="status" aria-live="polite" className="mt-2 text-sm text-amber-200">{discountStatus}</p> : null}
      {billingPeriod === 'yearly' ? <p className="mt-1 text-xs text-slate-400">{formatRand(quote.monthlyAmount)} monthly equivalent · billed yearly</p> : null}

      <ul className="mt-4 min-h-[7rem] space-y-2 text-sm text-slate-300">
        <li className="flex flex-wrap items-center gap-2" onClick={(event) => event.stopPropagation()}>
          <label className="sr-only" htmlFor={`${plan.id}-subject-count`}>Number of subjects for {plan.name}</label>
          <input
            id={`${plan.id}-subject-count`}
            type="number"
            inputMode="numeric"
            min="1"
            max="20"
            step="1"
            className="input h-8 w-16 shrink-0 px-2 py-0 text-center leading-none"
            value={subjectCountValue}
            onChange={handleSubjectCountChange}
            onBlur={() => setSubjectCountValue(String(subjectCount))}
            aria-label={`${plan.name} subject count`}
          />
          <span>1 subject included; {formatRand(quote.additionalSubjectAmountForPeriod)} per additional subject/{billingPeriod === 'yearly' ? 'year' : 'month'}</span>
        </li>
        {plan.id === 'circle' ? (
          <>
            <li>{quote.groupLessonsPerSubject} group lessons per subject in each subscription period ({quote.groupLessonsPerWindow} total)</li>
            <li>Examifying Program access for each registered subject</li>
          </>
        ) : (
          <>
            <li>{quote.oneOnOneLessonsPerSubject} one-on-one lessons per subject in each subscription period ({quote.oneOnOneLessonsPerWindow} total)</li>
            <li>{quote.groupLessonsPerSubject} group lessons per subject in each subscription period ({quote.groupLessonsPerWindow} total)</li>
            <li>Examifying Program access for each registered subject</li>
          </>
        )}
      </ul>

      {selected ? (
        <button
          type="button"
          className="btn-primary mt-5 w-full"
          disabled={isSubmitting || !onContinue || (Boolean(discountCode) && (!activeDiscountQuote || isValidatingDiscount))}
          onClick={(event) => {
            event.stopPropagation();
            onContinue?.({
              planId: plan.id,
              billingPeriod,
              subjectCount: quote.subjectCount,
              quote,
              ...(discountCode ? { discountCode } : {}),
            });
          }}
        >
          {isSubmitting ? 'Please wait…' : 'Continue to checkout'}
        </button>
      ) : null}
    </article>
  );
};

export const SubscriptionPlanSelector = ({
  onContinue,
  isSubmitting = false,
  initialSelection = {},
  mobileSwipe = false,
  studentId = null,
  initialDiscountCode = '',
  allowDiscountInput = false,
}) => {
  const [planId, setPlanId] = useState(['circle', 'personalized'].includes(initialSelection.planId)
    ? initialSelection.planId
    : 'circle');
  const [billingPeriod, setBillingPeriod] = useState(initialSelection.billingPeriod === 'yearly' ? 'yearly' : 'monthly');
  const [discountCode, setDiscountCode] = useState(String(initialDiscountCode || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10));
  const showDiscountInput = Boolean(studentId || allowDiscountInput || initialDiscountCode);

  useEffect(() => {
    setDiscountCode(String(initialDiscountCode || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10));
  }, [initialDiscountCode]);

  const continueWithFree = () => onContinue?.({ planId: 'free', billingPeriod, subjectCount: 0 });

  return (
    <section className="space-y-5" aria-labelledby="subscription-plans-heading">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-lime-400">Subscriptions</p>
          <h2 id="subscription-plans-heading" className="mt-1 text-2xl font-bold tracking-tight text-white">Choose your plan</h2>
          {mobileSwipe ? <p className="mt-2 text-xs text-slate-400 lg:hidden">Swipe left or right to compare plans.</p> : null}
        </div>
        <div className="flex w-full flex-col items-stretch gap-3 sm:w-auto sm:items-end">
          <div className="flex flex-wrap items-center justify-between gap-3 sm:justify-end">
            <button type="button" className="text-sm font-semibold text-slate-400 underline decoration-slate-600 underline-offset-4 hover:text-white" onClick={continueWithFree} disabled={isSubmitting}>
              Continue with Free question papers
            </button>
            <div className="flex items-center gap-2" role="group" aria-label="Billing period">
              <button type="button" onClick={() => setBillingPeriod('monthly')} aria-pressed={billingPeriod === 'monthly'} className={billingPeriod === 'monthly' ? 'btn-primary' : 'btn-secondary'}>Monthly</button>
              <button type="button" onClick={() => setBillingPeriod('yearly')} aria-pressed={billingPeriod === 'yearly'} className={`hidden ${billingPeriod === 'yearly' ? 'btn-primary' : 'btn-secondary'}`}>Yearly · 2 months free</button>
            </div>
          </div>
          {showDiscountInput ? (
            <div className="w-full sm:w-72">
              <input
                type="text"
                className="input h-10 px-3 py-2 font-mono uppercase tracking-wider"
                autoComplete="off"
                autoCapitalize="characters"
                maxLength={10}
                value={discountCode}
                onChange={(event) => setDiscountCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10))}
                placeholder="Discount code"
                aria-label="Discount code"
              />
              {!studentId && discountCode ? (
                <p className="mt-1 text-xs text-slate-400">
                  {discountCode.length < 10
                    ? 'Enter all 10 characters to preview the discount.'
                    : 'Price preview only; eligibility is verified after sign-in.'}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className={mobileSwipe
        ? 'flex snap-x snap-mandatory gap-4 overflow-x-auto overscroll-x-contain scroll-smooth pb-3 lg:grid lg:grid-cols-2 lg:overflow-visible lg:pb-0'
        : 'grid gap-4 lg:grid-cols-2'}>
        {paidPlans.map((plan) => (
          <PlanCard
            key={plan.id}
            plan={plan}
            billingPeriod={billingPeriod}
            initialSubjectCount={initialSelection.subjectCount}
            selected={planId === plan.id}
            studentId={studentId}
            discountCode={discountCode}
            mobileSwipe={mobileSwipe}
            isSubmitting={isSubmitting}
            onSelect={setPlanId}
            onContinue={onContinue}
          />
        ))}
      </div>
    </section>
  );
};
