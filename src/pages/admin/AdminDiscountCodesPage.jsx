import { useCallback, useEffect, useState } from 'react';
import { Copy, Link2, RefreshCw, Tag } from 'lucide-react';
import { AppShell } from '../../components/common/AppShell';
import { useAuth } from '../../hooks/useAuth';
import { createDiscountCode, listDiscountCodes, setDiscountCodeActive } from '../../services/discountCodesService';

const localDateTimeValue = (date) => {
  const offsetDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return offsetDate.toISOString().slice(0, 16);
};

const defaultForm = () => ({
  percentOff: '10',
  maxRedemptions: '1',
  restriction: 'none',
  restrictedValue: '',
  startsAt: localDateTimeValue(new Date()),
  redemptionExpiryMode: 'none',
  redemptionWindowMonths: '3',
  redemptionCustomMonths: '12',
  expiresAt: '',
  billingDuration: 'first_payment',
  discountDurationMonths: '3',
  customDiscountDurationMonths: '12',
});

const formatDate = (value) => value ? new Date(value).toLocaleString() : 'No expiry';
const formatRemaining = (code) => code.remainingUses === null ? 'Unlimited' : `${code.remainingUses} of ${code.maxRedemptions}`;
const buildShareLink = (code) => {
  const params = new URLSearchParams({ discountCode: code });
  return `${window.location.origin}/?${params.toString()}`;
};

export const AdminDiscountCodesPage = () => {
  const { profile, logout } = useAuth();
  const [codes, setCodes] = useState([]);
  const [form, setForm] = useState(defaultForm);
  const [status, setStatus] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [workingCode, setWorkingCode] = useState('');

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const result = await listDiscountCodes();
      setCodes(result.codes || []);
      setStatus('');
    } catch (error) {
      setStatus(error?.message || 'Could not load discount codes.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const updateForm = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));

  const handleCreate = async (event) => {
    event.preventDefault();
    setIsSaving(true);
    setStatus('');
    try {
      const payload = {
        percentOff: Number(form.percentOff),
        maxRedemptions: form.maxRedemptions.trim() ? Number(form.maxRedemptions) : null,
        restrictedEmail: form.restriction === 'email' ? form.restrictedValue.trim() : '',
        restrictedAccountId: form.restriction === 'account' ? form.restrictedValue.trim() : '',
        startsAt: new Date(form.startsAt).toISOString(),
        redemptionExpiryMode: form.redemptionExpiryMode,
        redemptionWindowMonths: form.redemptionExpiryMode === 'after_start'
          ? Number(form.redemptionWindowMonths === 'custom' ? form.redemptionCustomMonths : form.redemptionWindowMonths)
          : null,
        expiresAt: form.redemptionExpiryMode === 'manual' && form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
        billingDuration: form.billingDuration,
        discountDurationMonths: form.billingDuration === 'fixed_months'
          ? Number(form.discountDurationMonths === 'custom' ? form.customDiscountDurationMonths : form.discountDurationMonths)
          : null,
      };
      const result = await createDiscountCode(payload);
      setForm(defaultForm());
      setStatus(`Discount code ${result.code} created.`);
      await refresh();
    } catch (error) {
      setStatus(error?.message || 'Could not create the discount code.');
    } finally {
      setIsSaving(false);
    }
  };

  const toggleCode = async (code) => {
    setWorkingCode(code.code);
    setStatus('');
    try {
      await setDiscountCodeActive({ code: code.code, active: !code.active });
      await refresh();
    } catch (error) {
      setStatus(error?.message || 'Could not update the discount code.');
    } finally {
      setWorkingCode('');
    }
  };

  const copyCode = async (code) => {
    try {
      await navigator.clipboard.writeText(code);
      setStatus(`Copied ${code}.`);
    } catch {
      setStatus(`Copy failed. Code: ${code}`);
    }
  };

  const copyShareLink = async (code) => {
    const shareLink = buildShareLink(code);
    try {
      await navigator.clipboard.writeText(shareLink);
      setStatus(`Copied the share link for ${code}.`);
    } catch {
      setStatus(`Copy failed. Share link: ${shareLink}`);
    }
  };

  return (
    <AppShell title="Discount codes" subtitle="Create and manage server-validated subscription discounts." role="admin" user={profile} onLogout={logout}>
      <section className="panel p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-lime-400/10 text-lime-300"><Tag className="h-5 w-5" /></span>
          <div>
            <h2 className="text-lg font-bold text-white">Generate a discount code</h2>
            <p className="mt-1 text-sm text-slate-400">Codes are generated by the server, checked for collisions, and use the app’s subscription checkout.</p>
          </div>
        </div>

        <form onSubmit={handleCreate} className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <label className="block"><span className="label">Discount percentage</span><div className="relative"><input className="input pr-10" type="number" min="1" max="100" step="1" required value={form.percentOff} onChange={updateForm('percentOff')} /><span className="absolute right-3 top-3 text-slate-400">%</span></div></label>
          <label className="block"><span className="label">Maximum successful redemptions</span><input className="input" type="number" min="1" step="1" value={form.maxRedemptions} onChange={updateForm('maxRedemptions')} placeholder="Leave blank for unlimited" /><span className="mt-1 block text-xs text-slate-400">In-progress checkouts reserve capacity but do not count as successful.</span></label>
          <label className="block"><span className="label">Who can use it?</span><select className="input" value={form.restriction} onChange={updateForm('restriction')}><option value="none">Anyone eligible</option><option value="email">Specific email</option><option value="account">Specific account ID</option></select></label>
          {form.restriction !== 'none' ? <label className="block"><span className="label">{form.restriction === 'email' ? 'Restricted email address' : 'Restricted account ID'}</span><input className="input" type={form.restriction === 'email' ? 'email' : 'text'} required value={form.restrictedValue} onChange={updateForm('restrictedValue')} /></label> : null}
          <label className="block"><span className="label">Starts at</span><input className="input" type="datetime-local" required value={form.startsAt} onChange={updateForm('startsAt')} /></label>
          <div className="block"><label className="label" htmlFor="discount-redemption-expiry-mode">Code redemption window</label><select id="discount-redemption-expiry-mode" className="input" value={form.redemptionExpiryMode} onChange={updateForm('redemptionExpiryMode')}><option value="none">No expiry</option><option value="after_start">Expires after a period from the start date</option><option value="manual">Choose an expiry date</option></select>
            {form.redemptionExpiryMode === 'after_start' ? <div className="mt-2 flex gap-2"><select className="input" value={form.redemptionWindowMonths} onChange={updateForm('redemptionWindowMonths')} aria-label="Code redemption window length"><option value="1">1 month</option><option value="2">2 months</option><option value="3">3 months</option><option value="6">6 months</option><option value="12">12 months</option><option value="custom">Custom</option></select>{form.redemptionWindowMonths === 'custom' ? <input className="input" type="number" min="1" max="120" step="1" required value={form.redemptionCustomMonths} onChange={updateForm('redemptionCustomMonths')} aria-label="Custom code redemption window in months" /> : null}</div> : null}
            {form.redemptionExpiryMode === 'manual' ? <label className="mt-2 block"><span className="sr-only">Expires at</span><input className="input" type="datetime-local" required value={form.expiresAt} onChange={updateForm('expiresAt')} /></label> : null}
            <span className="mt-1 block text-xs text-slate-400">This controls when the code can be redeemed. A timed window is calculated by the server from the start date.</span>
          </div>
          <div className="block md:col-span-2 xl:col-span-3"><label className="label" htmlFor="discount-billing-duration">Discount duration after redemption</label><select id="discount-billing-duration" className="input" value={form.billingDuration} onChange={updateForm('billingDuration')}><option value="first_payment">First payment only</option><option value="fixed_months">First set number of monthly billing periods</option><option value="recurring">Permanent recurring discount for the same plan selection</option></select>
            {form.billingDuration === 'fixed_months' ? <div className="mt-2 flex max-w-xl gap-2"><select className="input" value={form.discountDurationMonths} onChange={updateForm('discountDurationMonths')} aria-label="Fixed discount duration"><option value="1">First 1 month</option><option value="2">First 2 months</option><option value="3">First 3 months</option><option value="6">First 6 months</option><option value="custom">Custom</option></select>{form.discountDurationMonths === 'custom' ? <input className="input" type="number" min="1" max="24" step="1" required value={form.customDiscountDurationMonths} onChange={updateForm('customDiscountDurationMonths')} aria-label="Custom discount duration in months" /> : null}</div> : null}
            <span className="mt-1 block text-xs text-slate-400">First-payment discounts stop after checkout. Fixed discounts are available on monthly subscriptions only; they start with each customer’s successful activation and run for that many monthly billing periods. Permanent recurring discounts continue while the same plan selection renews. Recurring charges and zero-cost renewals use Examifying’s existing Paystack authorization flow.</span>
          </div>
          <div className="md:col-span-2 xl:col-span-3"><button className="btn-primary" type="submit" disabled={isSaving}>{isSaving ? 'Creating…' : 'Generate code'}</button></div>
        </form>
      </section>

      <section className="panel mt-5 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 p-5">
          <div><h2 className="font-bold text-white">Discount codes</h2><p className="mt-1 text-sm text-slate-400">Successful redemptions count only after verified payment or secure zero-cost activation.</p></div>
          <button type="button" className="btn-secondary inline-flex items-center gap-2" onClick={refresh} disabled={isLoading}><RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />Refresh</button>
        </div>
        {status ? <p role="status" className="border-b border-slate-800 px-5 py-3 text-sm text-lime-200">{status}</p> : null}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1050px] text-left text-sm">
            <thead className="bg-slate-900/70 text-xs uppercase tracking-wide text-slate-400"><tr><th className="px-5 py-3">Code / discount</th><th className="px-5 py-3">Status</th><th className="px-5 py-3">Eligibility</th><th className="px-5 py-3">Billing duration</th><th className="px-5 py-3">Starts / expires</th><th className="px-5 py-3">Redemptions</th><th className="px-5 py-3">Remaining</th><th className="px-5 py-3">Action</th></tr></thead>
            <tbody className="divide-y divide-slate-800">
              {codes.map((code) => (
                <tr key={code.code}>
                  <td className="px-5 py-4"><button type="button" className="inline-flex items-center gap-2 font-mono font-bold tracking-wider text-lime-300" onClick={() => copyCode(code.code)}>{code.code}<Copy className="h-3.5 w-3.5" /></button><p className="mt-1 text-xs text-slate-400">{code.percentOff}% off</p><button type="button" className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-lime-300 hover:text-lime-200" onClick={() => copyShareLink(code.code)}><Link2 className="h-3.5 w-3.5" />Copy share link</button></td>
                  <td className="px-5 py-4"><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${code.status === 'Active' ? 'bg-lime-400/10 text-lime-300' : 'bg-slate-700 text-slate-300'}`}>{code.status}</span></td>
                  <td className="px-5 py-4 text-slate-300">{code.restrictedEmail || (code.restrictedAccountId ? `Account ${code.restrictedAccountId}` : 'Any eligible account')}</td>
                  <td className="px-5 py-4 text-slate-300">{code.billingDuration === 'fixed_months' ? `First ${code.discountDurationMonths} monthly periods` : code.billingDuration === 'first_payment' ? 'First payment' : 'Permanent recurring'}</td>
                  <td className="px-5 py-4 text-slate-300">{formatDate(code.startsAt)}<br /><span className="text-xs text-slate-500">{formatDate(code.expiresAt)}</span></td>
                  <td className="px-5 py-4 text-slate-300">{code.successfulRedemptions}{code.reservedRedemptions ? <span className="block text-xs text-amber-300">{code.reservedRedemptions} checkout(s) pending</span> : null}</td>
                  <td className="px-5 py-4 text-slate-300">{formatRemaining(code)}</td>
                  <td className="px-5 py-4"><button type="button" className="btn-secondary whitespace-nowrap" disabled={workingCode === code.code || code.status === 'Expired' || code.status === 'Exhausted'} onClick={() => toggleCode(code)}>{workingCode === code.code ? 'Saving…' : code.active ? 'Deactivate' : 'Activate'}</button></td>
                </tr>
              ))}
              {!isLoading && codes.length === 0 ? <tr><td colSpan="8" className="px-5 py-10 text-center text-slate-400">No discount codes created yet.</td></tr> : null}
              {isLoading ? <tr><td colSpan="8" className="px-5 py-10 text-center text-slate-400">Loading discount codes…</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </AppShell>
  );
};
