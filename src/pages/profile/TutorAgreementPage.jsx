import { useState } from 'react';
import { AppShell } from '../../components/common/AppShell';
import { useAuth } from '../../hooks/useAuth';
import { ROLES } from '../../lib/constants';
import { signTutorAgreement } from '../../services/firestoreService';
import { useOperationStatus } from '../../hooks/useOperationStatus';

export const TutorAgreementPage = () => {
  const { profile, logout, refreshProfile } = useAuth();
  const { runOperation } = useOperationStatus();
  const [legalName, setLegalName] = useState(profile?.tutorAgreement?.legalName ?? profile?.displayName ?? '');
  const [accepted, setAccepted] = useState(Boolean(profile?.tutorAgreement?.accepted));
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSign = async (event) => {
    event.preventDefault();
    try {
      setSaving(true);
      setStatus('Saving tutor agreement...');
      const agreement = await runOperation({ operationName: 'Signing tutor agreement', successMessage: 'The tutor agreement was saved.' }, async () => {
        const saved = await signTutorAgreement({ tutorId: profile.uid, legalName, accepted });
        await refreshProfile(profile.uid);
        return saved;
      });
      setStatus(`Tutor agreement signed on ${new Date(agreement.signedAt).toLocaleString()}.`);
    } catch (error) {
      setStatus(error.message || 'Could not sign agreement.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppShell title="Tutor agreement" subtitle="Review and sign the Examifying tutor contract/agreement." role={ROLES.TUTOR} user={profile} onLogout={logout}>
      <form onSubmit={handleSign} className="panel max-w-3xl space-y-5 p-6">
        <div className="rounded-2xl bg-slate-50 p-5 text-sm leading-7 text-slate-600">
          <p className="font-semibold text-slate-950">Examifying tutor agreement</p>
          <p className="mt-2">By signing, the tutor agrees to support assigned learners professionally, keep student information confidential, provide accurate lesson records, and follow Examifying platform rules.</p>
        </div>
        <label>
          <span className="label">Full legal name</span>
          <input className="input" value={legalName} onChange={(event) => setLegalName(event.target.value)} required />
        </label>
        <label className="flex items-start gap-3 text-sm text-slate-600">
          <input type="checkbox" className="mt-1" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />
          <span>I have read and accept the Examifying tutor agreement.</span>
        </label>
        <button className="btn-primary" disabled={saving}>{saving ? 'Signing...' : 'Sign agreement'}</button>
        {profile?.tutorAgreement?.signedAt ? <p className="text-sm text-emerald-700">Current signed agreement: {new Date(profile.tutorAgreement.signedAt).toLocaleString()}</p> : null}
        {status ? <p className="text-sm text-slate-600">{status}</p> : null}
      </form>
    </AppShell>
  );
};
