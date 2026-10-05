const formatRand = (amount) => `R${Number(amount || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const formatDate = (value) => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString() : 'the next billing date';
};

export const AuthorizationChargeDisclosure = ({ checkout, onContinue, onCancel, isCancelling = false }) => {
  if (!checkout) return null;
  return (
    <section className="panel space-y-3 border-amber-400/40 p-5" role="dialog" aria-modal="true" aria-labelledby="authorization-charge-title">
      <h2 id="authorization-charge-title" className="text-lg font-bold text-slate-950">Card authorization for your free offer</h2>
      <p className="text-sm text-slate-700">
        Your subscription charge today is <strong>R0.00</strong>. Paystack will temporarily charge <strong>{formatRand(checkout.authorizationChargeAmount)}</strong> to verify and authorize your card for future subscription renewals. After payment is verified, Examifying will automatically request a refund for this temporary charge. Paystack may take time to process the refund; it is not instant.
      </p>
      {checkout.noNextChargeWhileOfferApplies ? (
        <p className="text-sm text-slate-700">This permanent 100% offer has no next subscription charge while it remains active.</p>
      ) : (
        <p className="text-sm text-slate-700">
          Your next actual subscription charge is expected on <strong>{formatDate(checkout.nextBillingDate)}</strong> for <strong>{formatRand(checkout.nextBillingAmount)}</strong>, according to this offer’s duration.
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <button type="button" className="btn-primary" onClick={onContinue}>Continue to card authorization</button>
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={isCancelling}>
          {isCancelling ? 'Cancelling…' : 'Cancel checkout'}
        </button>
      </div>
    </section>
  );
};
