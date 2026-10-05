const CATEGORY_BY_TYPE = {
  'account.created': 'account_updates',
  'user.created': 'account_updates',
  'payment.success': 'payment_updates',
  'payment.failed': 'payment_updates',
  'payment.initialized': 'payment_updates',
  'payment.pending': 'payment_updates',
  'payment.processing': 'payment_updates',
  'payment.verification_pending': 'payment_updates',
  'payment.abandoned': 'payment_updates',
  'payment.cancelled': 'payment_updates',
  'payment.reversed': 'payment_updates',
  'payment.past_due': 'payment_updates',
  'payment.amount_mismatch': 'payment_updates',
  'payment.refunded': 'payment_updates',
  'payment.authorization_refund': 'payment_updates',
  'tutor-assignment.created': 'tutor_assignments',
  'tutor-assignment.student': 'tutor_assignments',
  'tutor-assignment.tutor': 'tutor_assignments',
  'exercise-generation.completed': 'exercise_generation',
  'exercise.submitted': 'exercise_submissions',
  'peer-marking.completed': 'peer_marking',
  'tutor-report.created': 'tutor_reports',
  'lesson.completed': 'lesson_updates',
  'discount.offer': 'discount_offers',
};

const LEARNING_CATEGORIES = new Set([
  'exercise_generation',
  'exercise_submissions',
  'peer_marking',
  'tutor_reports',
  'lesson_updates',
]);

export const getNotificationPreferenceCategory = (type) => CATEGORY_BY_TYPE[type] || null;

export const isNotificationChannelEnabled = (profile, type, channel) => {
  const category = getNotificationPreferenceCategory(type);
  if (!category || !['inApp', 'email'].includes(channel)) return true;
  if (channel === 'email' && category === 'discount_offers' && profile?.marketingEmailOptIn !== true) return false;

  const saved = profile?.settings?.notificationPreferences?.[category]?.[channel];
  if (typeof saved === 'boolean') return saved;
  if (channel === 'email' && typeof profile?.settings?.emailUpdates === 'boolean') return profile.settings.emailUpdates;
  if (channel === 'inApp' && LEARNING_CATEGORIES.has(category) && profile?.settings?.learningReminders === false) return false;
  return true;
};
