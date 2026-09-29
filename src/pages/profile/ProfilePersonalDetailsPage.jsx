import { useState } from 'react';
import { AppShell } from '../../components/common/AppShell';
import { useAuth } from '../../hooks/useAuth';
import { updateUserProfileDetails } from '../../services/authService';
import { ROLES, SOUTH_AFRICAN_GRADES } from '../../lib/constants';

export const ProfilePersonalDetailsPage = ({ role }) => {
  const { profile, logout, refreshProfile, isDemoMode } = useAuth();
  const [displayName, setDisplayName] = useState(profile?.displayName || '');
  const [previousYearMark, setPreviousYearMark] = useState(profile?.previousYearMark ?? 0);
  const [grade, setGrade] = useState(profile?.grade || SOUTH_AFRICAN_GRADES[0]);
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const handleSave = async (event) => {
    event.preventDefault();
    setSaving(true);
    setMessage('');

    try {
      await updateUserProfileDetails({
        uid: profile?.uid,
        displayName,
        previousYearMark: role === ROLES.STUDENT ? previousYearMark : undefined,
        grade: role === ROLES.STUDENT ? grade : undefined,
        newPassword: password || undefined,
      });
      if (!isDemoMode) await refreshProfile(profile.uid);
      setPassword('');
      setMessage('Personal details updated successfully.');
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
              <select className="input" value={grade} onChange={(event) => setGrade(event.target.value)} required>
                {SOUTH_AFRICAN_GRADES.map((item) => <option key={item}>{item}</option>)}
              </select>
            </label>
            <label>
              <span className="label">Previous year mark (%)</span>
              <input type="number" min="0" max="100" className="input" value={previousYearMark} onChange={(event) => setPreviousYearMark(event.target.value)} required />
            </label>
          </>
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
