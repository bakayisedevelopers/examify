import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions';
import { getDb } from './admin.js';
import { chargeAuthorizationForSubscription } from './paystack.js';

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

    for (const doc of dueSubscriptionsSnapshot.docs) {
      const subscription = doc.data();
      const studentId = subscription.studentId;

      try {
        const authDoc = await db.collection('subscriptionAuthorizations').doc(studentId).get();

        if (!authDoc.exists) {
          logger.error('Missing stored authorization', { studentId });
          await db.collection('subscriptions').doc(studentId).set(
            {
              status: 'past_due',
              lastChargeStatus: 'missing_authorization',
              lastChargeAttemptAt: new Date(),
            },
            { merge: true }
          );
          continue;
        }

        const auth = authDoc.data();

        await chargeAuthorizationForSubscription({
          studentId,
          email: auth.email,
          amount: subscription.amount,
          authorizationCode: auth.authorizationCode,
          metadata: {
            sessionType: subscription.sessionType ?? 'online',
            sessionCount: subscription.sessionCount ?? 1,
          },
        });

        logger.info('Subscription renewed successfully', { studentId });
      } catch (error) {
        logger.error('Subscription renewal failed', {
          studentId,
          error: error?.message ?? String(error),
        });

        await db.collection('subscriptions').doc(studentId).set(
          {
            status: 'past_due',
            lastChargeStatus: 'failed',
            lastChargeAttemptAt: new Date(),
          },
          { merge: true }
        );

        await db.collection('users').doc(studentId).set(
          {
            subscriptionStatus: 'past_due',
            updatedAt: new Date(),
          },
          { merge: true }
        );
      }
    }
  }
);
