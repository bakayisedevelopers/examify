import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { SubscriptionLifecyclePanel } from '../../components/billing/SubscriptionLifecyclePanel';
import { useAuth } from '../../hooks/useAuth';
import { updateUserProfileDetails } from '../../services/authService';
import { useStudentSubscriptionState } from '../../hooks/useStudentSubscriptionState';

export const StudentProfilePage = () => {
  const { profile, logout, isDemoMode } = useAuth();
  const navigate = useNavigate();
  const subscriptionState = useStudentSubscriptionState(profile);
  
  const [displayName, setDisplayName] = useState(profile?.displayName || '');
  const [whatsappNumber, setWhatsAppNumber] = useState(profile?.whatsappNumber || '');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setMessage('');
    try {
      await updateUserProfileDetails({
        uid: profile?.uid,
        displayName,
        whatsappNumber,
        newPassword: password || undefined,
      });
      setMessage('Profile updated successfully!');
      setPassword('');
      if (isDemoMode) {
        alert('Profile saved (Demo mode)');
      }
    } catch (err) {
      setMessage(err.message || 'Failed to update profile');
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppShell
      title="Profile"
      subtitle="Review and update your learner profile and security settings."
      role="student"
      user={profile}
      onLogout={logout}
    >
      <form onSubmit={handleSave} className="panel p-6 max-w-2xl grid gap-6">
        {message && (
          <div className="rounded-xl bg-brand-50 p-4 text-sm font-medium text-brand-700">
            {message}
          </div>
        )}
        
        <div>
          <label className="label">Full Name</label>
          <input
            type="text"
            className="input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
          />
        </div>

        <div>
          <label className="label">WhatsApp number</label>
          <input type="tel" inputMode="tel" autoComplete="tel" className="input" value={whatsappNumber} onChange={(event) => setWhatsAppNumber(event.target.value)} placeholder="082 123 4567 or +27 82 123 4567" required />
        </div>

        <div>
          <label className="label">
            New Password (leave blank to keep current)
          </label>
          <input
            type="password"
            minLength="6"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        <div>
          <button
            type="submit"
            disabled={saving}
            className="btn-primary w-full md:w-auto"
          >
            {saving ? 'Saving...' : 'Update Profile'}
          </button>
        </div>
      </form>

      <div className="mt-6 max-w-2xl">
        <SubscriptionLifecyclePanel
          studentId={profile?.uid}
          subscriptionState={subscriptionState}
          onContinuePayment={() => navigate('/student/billing')}
        />
      </div>

      <div className="grid gap-4 md:grid-cols-3 mt-6">
        <div className="panel p-5">
          <p className="text-sm text-slate-500">Grade</p>
          <p className="mt-2 text-xl font-semibold text-slate-950">
            {profile?.grade || 'Not set'}
          </p>
        </div>
        <div className="panel p-5">
          <p className="text-sm text-slate-500">Province</p>
          <p className="mt-2 text-xl font-semibold text-slate-950">
            {profile?.province || 'Not set'}
          </p>
        </div>
        <div className="panel p-5">
          <p className="text-sm text-slate-500">Subscription</p>
          <p className="mt-2 text-xl font-semibold text-slate-950">
            {subscriptionState?.paymentCompleted ? `Active · ${subscriptionState.subscriptionPlanName}` : (subscriptionState?.subscriptionPlanName || 'Checking')}
          </p>
        </div>
      </div>

      <div className="panel mt-6 p-5 text-sm text-slate-600">
        Environment mode: {isDemoMode ? 'Demo' : 'Live'}.
      </div>
    </AppShell>
  );
};
