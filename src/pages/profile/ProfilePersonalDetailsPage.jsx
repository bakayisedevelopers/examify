import { useEffect, useState } from 'react';
import { AppShell } from '../../components/common/AppShell';
import { useAuth } from '../../hooks/useAuth';
import { updateUserProfileDetails } from '../../services/authService';
import { getStudentSubjectHistoryOptions } from '../../services/firestoreService';
import { ROLES, SOUTH_AFRICAN_GRADES } from '../../lib/constants';
import { getTutorWhatsAppSettings } from '../../services/whatsappService';

export const ProfilePersonalDetailsPage = ({ role }) => {
  const { profile, logout, refreshProfile, isDemoMode } = useAuth();
  const [displayName, setDisplayName] = useState(profile?.displayName || '');
  const [grade, setGrade] = useState(profile?.grade || SOUTH_AFRICAN_GRADES[0]);
  const [whatsappNumber, setWhatsAppNumber] = useState(profile?.whatsappNumber || '');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [historyCandidates, setHistoryCandidates] = useState([]);
  const [subjectCapacity, setSubjectCapacity] = useState(0);
  const [selectedHistoryIds, setSelectedHistoryIds] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const isTutorRole = role === ROLES.TUTOR || role === 'teacher';
  const [whatsappLoading, setWhatsAppLoading] = useState(isTutorRole && !isDemoMode);

  useEffect(() => {
    if (role !== ROLES.STUDENT || !profile?.uid || !grade || grade === profile.grade) {
      setHistoryCandidates([]);
      setSelectedHistoryIds([]);
      setHistoryError('');
      return undefined;
    }
    let active = true;
    setHistoryLoading(true);
    setHistoryError('');
    getStudentSubjectHistoryOptions({ studentId: profile.uid, grade }).then((result) => {
      if (!active) return;
      setHistoryCandidates(Array.isArray(result.candidates) ? result.candidates : []);
      setSubjectCapacity(Number(result.subjectCapacity) || 0);
    }).catch((error) => {
      if (active) {
        setHistoryCandidates([]);
        setSubjectCapacity(0);
        setHistoryError(error.message || 'Could not check for recent subject history.');
      }
    }).finally(() => { if (active) setHistoryLoading(false); });
    return () => { active = false; };
  }, [grade, profile?.grade, profile?.uid, role]);

  useEffect(() => {
    if (isDemoMode) {
      setWhatsAppLoading(false);
      return undefined;
    }
    if (!isTutorRole || !profile?.uid) return undefined;
    let active = true;
    setWhatsAppLoading(true);
    getTutorWhatsAppSettings().then((settings) => {
      if (active) setWhatsAppNumber(settings.whatsappNumber || '');
    }).catch((error) => {
      if (active) setMessage(error.message || 'Could not load your private WhatsApp number.');
    }).finally(() => { if (active) setWhatsAppLoading(false); });
    return () => { active = false; };
  }, [isDemoMode, isTutorRole, profile?.uid]);

  const handleSave = async (event) => {
    event.preventDefault();
    setSaving(true);
    setMessage('');

    try {
      const result = await updateUserProfileDetails({
        uid: profile?.uid,
        displayName,
        grade: role === ROLES.STUDENT ? grade : undefined,
        whatsappNumber: role === ROLES.STUDENT || isTutorRole ? whatsappNumber : undefined,
        role,
        newPassword: password || undefined,
        restoreSubjectInstanceIds: role === ROLES.STUDENT ? selectedHistoryIds : [],
      });
      if (!isDemoMode) await refreshProfile(profile.uid);
      setPassword('');
      const restored = result.gradeChangeResult?.restoredSubjects ?? [];
      setMessage(result.gradeChangeResult && !result.gradeChangeResult.unchanged
        ? `Grade changed to ${grade}. ${restored.length ? `${restored.join(', ')} topic history restored.` : 'No subject history was restored; add destination-grade subjects under Profile → Subjects.'}`
        : 'Personal details updated successfully.');
      setSelectedHistoryIds([]);
    } catch (error) {
      setMessage(error.message || 'Failed to update personal details.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppShell title="Personal details" subtitle="Update your profile information and account security." role={role} user={profile} onLogout={logout}>
      <form onSubmit={handleSave} className="panel grid max-w-2xl gap-6 p-6">
        {message ? <div className="rounded-xl bg-brand-50 p-4 text-sm font-medium text-brand-700">{message}</div> : null}
        <label>
          <span className="label">Full name</span>
          <input className="input" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required />
        </label>
        <label>
          <span className="label">Email</span>
          <input className="input" value={profile?.email ?? ''} disabled />
        </label>
        {role === ROLES.STUDENT ? (
          <>
            <label>
              <span className="label">Grade</span>
              <select className="input" value={grade} onChange={(event) => { setGrade(event.target.value); setSelectedHistoryIds([]); setHistoryError(''); }} required>
                {SOUTH_AFRICAN_GRADES.map((item) => <option key={item}>{item}</option>)}
              </select>
            </label>
            {grade !== profile?.grade ? <section className="space-y-3 rounded-2xl border border-amber-200 bg-amber-50 p-4" aria-label="Optional topic history restoration">
              <div>
                <p className="text-sm font-semibold text-amber-950">Choose recent subject history to restore (optional)</p>
                <p className="mt-1 text-xs text-amber-900">Changing grade cancels current subjects. Only selected same-grade histories from the last three months are copied, and only topics plus understanding scores are restored. Add any other subjects after the grade change.</p>
              </div>
              {historyLoading ? <p className="text-sm text-amber-900" role="status">Checking eligible subject history…</p> : null}
              {historyError ? <p className="text-sm font-medium text-rose-700" role="alert">{historyError}</p> : null}
              {!historyLoading && !historyError && !historyCandidates.length ? <p className="text-sm text-amber-900">No eligible subject history was found for {grade}.</p> : null}
              {historyCandidates.length ? <>
                <p className="text-xs text-amber-900">Your current subscription allows up to {subjectCapacity} subject{subjectCapacity === 1 ? '' : 's'}.</p>
                <div className="space-y-2">
                  {historyCandidates.map((candidate) => {
                    const checked = selectedHistoryIds.includes(candidate.episodeId);
                    const overLimit = !checked && selectedHistoryIds.length >= subjectCapacity;
                    return <label key={candidate.episodeId} className="flex items-start gap-3 rounded-xl bg-white/80 p-3 text-sm text-slate-700">
                      <input type="checkbox" className="mt-0.5" checked={checked} disabled={historyLoading || subjectCapacity === 0 || overLimit} onChange={(event) => setSelectedHistoryIds((current) => event.target.checked
                        ? [...current, candidate.episodeId]
                        : current.filter((id) => id !== candidate.episodeId))} />
                      <span><span className="font-semibold">{candidate.subject}</span><span className="block text-xs text-slate-500">Cancelled {new Date(candidate.cancelledAt).toLocaleDateString()} · topics and understanding scores only</span></span>
                    </label>;
                  })}
                </div>
              </> : null}
              {subjectCapacity === 0 && !historyLoading ? <p className="text-xs text-amber-900">An active paid plan is required to restore subject history.</p> : null}
            </section> : null}
            <label>
              <span className="label">WhatsApp number</span>
              <input type="tel" inputMode="tel" autoComplete="tel" className="input" value={whatsappNumber} onChange={(event) => setWhatsAppNumber(event.target.value)} placeholder="082 123 4567 or +27 82 123 4567" required />
            </label>
          </>
        ) : null}
        {isTutorRole ? (
          <label>
            <span className="label">WhatsApp number</span>
            <input type="tel" inputMode="tel" autoComplete="tel" className="input" value={whatsappNumber} onChange={(event) => setWhatsAppNumber(event.target.value)} placeholder="+27 82 123 4567 or +44 20 1234 5678" required disabled={whatsappLoading} />
            <span className="mt-1 block text-xs text-slate-500">Enter an international number with its country code. Assigned students see this only for an upcoming online one-on-one lesson.</span>
          </label>
        ) : null}
        <label>
          <span className="label">New password</span>
          <input type="password" minLength="6" className="input" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Leave blank to keep current password" />
        </label>
        <button className="btn-primary w-full md:w-auto" disabled={saving}>{saving ? 'Saving...' : 'Save details'}</button>
      </form>
    </AppShell>
  );
};
