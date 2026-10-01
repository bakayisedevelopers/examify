import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions';
import { admin, getDb } from './admin.js';
import { chargeAuthorizationForSubscription } from './paystack.js';
import { calculateSubscriptionQuote } from './subscriptionPricing.js';

export const processSubscriptionRenewals = onSchedule(
  {
    schedule: 'every day 01:00',
    timeZone: 'Africa/Johannesburg',
  },
  async () => {
    const db = getDb();
    const now = new Date();
    const dueSubscriptionsSnapshot = await db
      .collection('subscriptions')
      .where('autoRenew', '==', true)
      .where('status', '==', 'active')
      .where('renewalDate', '<=', now)
      .get();

    logger.info('Found due subscriptions', { count: dueSubscriptionsSnapshot.size });

    for (const subscriptionDoc of dueSubscriptionsSnapshot.docs) {
      const subscription = subscriptionDoc.data();
      const studentId = subscription.studentId;
      const subscriptionRef = db.collection('subscriptions').doc(studentId);
      const userRef = db.collection('users').doc(studentId);

      if (!subscription.planId && !subscription.pendingPlan?.planId) {
        logger.warn('Disabling renewal for a legacy subscription without a selected plan', { studentId });
        await Promise.all([
          subscriptionRef.set({ status: 'plan_required', autoRenew: false, lastChargeStatus: 'legacy_plan_removed' }, { merge: true }),
          userRef.set({ paymentCompleted: false, subscriptionStatus: 'plan_required', updatedAt: now }, { merge: true }),
        ]);
        continue;
      }

      const selectedPlan = subscription.pendingPlan?.planId ? subscription.pendingPlan : subscription;
      let subscriptionQuote;
      try {
        subscriptionQuote = calculateSubscriptionQuote({
          planId: selectedPlan.planId,
          billingPeriod: selectedPlan.billingPeriod,
          subjectCount: selectedPlan.subjectCount,
        });
      } catch (error) {
        logger.error('Subscription plan could not be priced for renewal', { studentId, error: error.message });
        await Promise.all([
          subscriptionRef.set({ status: 'plan_required', autoRenew: false }, { merge: true }),
          userRef.set({ paymentCompleted: false, subscriptionStatus: 'plan_required', updatedAt: now }, { merge: true }),
        ]);
        continue;
      }

      if (subscription.pendingPlan?.planId === 'free') {
        const batch = db.batch();
        batch.set(subscriptionRef, {
          ...subscriptionQuote,
          studentId,
          status: 'active',
          amount: 0,
          latestReference: subscription.pendingPlanReference ?? subscription.latestReference ?? null,
          renewalDate: null,
          autoRenew: false,
          pendingPlan: admin.firestore.FieldValue.delete(),
          pendingPlanReference: admin.firestore.FieldValue.delete(),
          updatedAt: now,
        }, { merge: true });
        batch.set(userRef, {
          paymentCompleted: false,
          subscriptionStatus: 'active',
          subscriptionPlanId: 'free',
          subscriptionPlanName: 'Free',
          subscriptionBillingPeriod: subscriptionQuote.billingPeriod,
          subscriptionSubjectCount: 0,
          subscriptionRenewalDate: null,
          pendingSubscriptionPlan: admin.firestore.FieldValue.delete(),
          updatedAt: now,
        }, { merge: true });
        if (subscription.pendingPlanReference) {
          batch.set(db.collection('payments').doc(subscription.pendingPlanReference), {
            status: 'applied',
            appliedAt: now,
          }, { merge: true });
        }
        await batch.commit();
        continue;
      }

      try {
        const authSnapshot = await db.collection('subscriptionAuthorizations').doc(studentId).get();
        if (!authSnapshot.exists) {
          logger.error('Missing stored authorization', { studentId });
          await Promise.all([
            subscriptionRef.set({ status: 'past_due', autoRenew: false, lastChargeStatus: 'missing_authorization', lastChargeAttemptAt: now }, { merge: true }),
            userRef.set({ paymentCompleted: false, subscriptionStatus: 'past_due', updatedAt: now }, { merge: true }),
          ]);
          continue;
        }

        const authorization = authSnapshot.data();
        const result = await chargeAuthorizationForSubscription({
          studentId,
          email: authorization.email,
          amount: subscriptionQuote.amount,
          authorizationCode: authorization.authorizationCode,
          subscriptionQuote,
        });
        if (!result.succeeded) throw new Error(`Paystack renewal status: ${result.charge.status}`);
        logger.info('Subscription renewed successfully', { studentId });
      } catch (error) {
        logger.error('Subscription renewal failed', { studentId, error: error?.message ?? String(error) });
        await Promise.all([
          subscriptionRef.set({ status: 'past_due', autoRenew: false, lastChargeStatus: 'failed', lastChargeAttemptAt: new Date() }, { merge: true }),
          userRef.set({ paymentCompleted: false, subscriptionStatus: 'past_due', updatedAt: new Date() }, { merge: true }),
        ]);
      }
    }
  }
);
