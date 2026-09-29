import { useState } from 'react';
import { AppShell } from '../../components/common/AppShell';
import { useAuth } from '../../hooks/useAuth';
import { updateUserSettings } from '../../services/firestoreService';
import { deleteCurrentUserAccount } from '../../services/authService';

export const ProfileSettingsPage = ({ role }) => {
  const { profile, logout, refreshProfile } = useAuth();
  const [settings, setSettings] = useState({
    emailUpdates: profile?.settings?.emailUpdates ?? true,
    learningReminders: profile?.settings?.learningReminders ?? true,
  });
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleToggle = (key) => setSettings((current) => ({ ...current, [key]: !current[key] }));

  const handleSave = async () => {
    try {
      setSaving(true);
      setStatus('Saving settings...');
      await updateUserSettings({ uid: profile.uid, settings });
      await refreshProfile(profile.uid);
      setStatus('Settings saved.');
    } catch (error) {
      setStatus(error.message || 'Could not save settings.');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteAccount = async () => {
    const typed = window.prompt('Type DELETE to permanently delete your account.');
    if (typed !== 'DELETE') {
      setStatus('Account deletion cancelled.');
      return;
    }

    try {
      setDeleting(true);
      setStatus('Deleting account...');
      await deleteCurrentUserAccount(profile.uid);
    } catch (error) {
      const message = error?.code === 'auth/requires-recent-login'
        ? 'Please log out, log back in, and then delete the account again.'
        : error.message || 'Could not delete account.';
      setStatus(message);
      setDeleting(false);
    }
  };

  return (
    <AppShell title="Settings" subtitle="Manage account preferences." role={role} user={profile} onLogout={logout}>
      <section className="panel max-w-2xl space-y-5 p-6">
        <label className="flex items-center justify-between gap-4">
          <span><span className="block font-semibold text-slate-950">Email updates</span><span className="text-sm text-slate-500">Receive account and platform updates.</span></span>
          <input type="checkbox" checked={settings.emailUpdates} onChange={() => handleToggle('emailUpdates')} />
        </label>
        <label className="flex items-center justify-between gap-4">
          <span><span className="block font-semibold text-slate-950">Learning reminders</span><span className="text-sm text-slate-500">Receive reminders related to lessons, exercises, and subjects.</span></span>
          <input type="checkbox" checked={settings.learningReminders} onChange={() => handleToggle('learningReminders')} />
        </label>
        <button className="btn-primary" onClick={handleSave} disabled={saving || deleting}>{saving ? 'Saving...' : 'Save settings'}</button>
        {status ? <p className="text-sm text-slate-600">{status}</p> : null}
      </section>

      <section className="panel max-w-2xl space-y-4 border-rose-200 p-6">
        <div>
          <p className="font-semibold text-rose-700">Delete account</p>
          <p className="mt-2 text-sm text-slate-500">This permanently deletes the signed-in account and its user profile record.</p>
        </div>
        <button
          type="button"
          onClick={handleDeleteAccount}
          disabled={deleting}
          className="rounded-full bg-rose-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-rose-700 disabled:opacity-60"
        >
          {deleting ? 'Deleting...' : 'Delete account'}
        </button>
      </section>
    </AppShell>
  );
};
