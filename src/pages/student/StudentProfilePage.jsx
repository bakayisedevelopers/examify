import { useState } from 'react';
import { AppShell } from '../../components/common/AppShell';
import { useAuth } from '../../hooks/useAuth';
import { updateUserProfileDetails } from '../../services/authService';

// 🔥 NEW: Firestore imports
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../../firebase/config';

export const StudentProfilePage = () => {
  const { profile, logout, isDemoMode } = useAuth();
  
  const [displayName, setDisplayName] = useState(profile?.displayName || '');
  const [previousYearMark, setPreviousYearMark] = useState(profile?.previousYearMark ?? 0);
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  // 🔥 NEW STATE
  const [cancelling, setCancelling] = useState(false);

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setMessage('');
    try {
      await updateUserProfileDetails({
        uid: profile?.uid,
        displayName,
        previousYearMark,
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

  // 🔥 NEW: CANCEL SUBSCRIPTION LOGIC
  const handleCancelSubscription = async () => {
    const confirmCancel = window.confirm(
      'Are you sure you want to cancel your subscription? You will not be billed again.'
    );

    if (!confirmCancel) return;

    setCancelling(true);
    setMessage('');

    try {
      if (isDemoMode) {
        alert('Subscription cancelled (Demo mode)');
        setMessage('Subscription cancelled successfully.');
        return;
      }

      const userRef = doc(db, 'users', profile?.uid);
      const subscriptionRef = doc(db, 'subscriptions', profile?.uid);

      // Update user document
      await updateDoc(userRef, {
        subscriptionRenewalDate: null,
      });

      // Update subscription document
      await updateDoc(subscriptionRef, {
        renewalDate: null,
        billingCycleDays: null,
        autoRenew: false,
      });

      setMessage('Subscription cancelled successfully.');
    } catch (error) {
      console.error('[Examifying][CancelSubscription] error', error);
      setMessage('Failed to cancel subscription. Please try again.');
    } finally {
      setCancelling(false);
    }
  };

  return (
    <AppShell
      title="Profile"
      subtitle="Review and update your learner profile, onboarding mark, and security settings."
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
          <label className="label">Previous year mark (%)</label>
          <input
            type="number"
            min="0"
            max="100"
            className="input"
            value={previousYearMark}
            onChange={(e) => setPreviousYearMark(e.target.value)}
            required
          />
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

      {/* 🔥 NEW: CANCEL SUBSCRIPTION SECTION */}
      <div className="panel mt-6 p-6 max-w-2xl">
        <h3 className="text-lg font-semibold text-slate-950">
          Subscription Management
        </h3>
        <p className="mt-2 text-sm text-slate-500">
          Cancel your subscription to stop future billing. Your access will remain
          active until the end of your current billing cycle.
        </p>

        <button
          onClick={handleCancelSubscription}
          disabled={cancelling}
          className="mt-4 w-full md:w-auto rounded-xl bg-rose-600 px-5 py-3 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-60"
        >
          {cancelling ? 'Cancelling...' : 'Cancel Subscription'}
        </button>
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
          <p className="text-sm text-slate-500">Payment state</p>
          <p className="mt-2 text-xl font-semibold text-slate-950">
            {profile?.paymentCompleted ? 'Paid' : 'Pending'}
          </p>
        </div>
      </div>

      <div className="panel mt-6 p-5 text-sm text-slate-600">
        Environment mode: {isDemoMode ? 'Demo' : 'Live'}.
      </div>
    </AppShell>
  );
};