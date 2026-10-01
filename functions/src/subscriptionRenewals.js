import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions';
import { admin, getDb } from './admin.js';
import { applyFreeSubscription, chargeAuthorizationForSubscription } from './paystack.js';
import { calculateSubscriptionQuote } from './subscriptionPricing.js';

const MAX_RENEWAL_ATTEMPTS = 3;
const RENEWAL_GRACE_DAYS = 3;
const RETRY_DELAY_HOURS = 24;

const renewalGraceEnd = (dueDate) => new Date(dueDate.getTime() + RENEWAL_GRACE_DAYS * 24 * 60 * 60 * 1000);
const isInFlight = (attempt) => ['processing', 'unknown'].includes(attempt?.status);

const setManualPaymentRequired = async ({ db, studentId, dueDate, reason }) => {
  const graceEndsAt = renewalGraceEnd(dueDate);
  if (graceEndsAt <= new Date()) {
    await applyFreeSubscription({ studentId, pendingStatus: 'expired', reason });
    return;
  }

  await Promise.all([
    db.collection('subscriptions').doc(studentId).set({
      status: 'past_due',
      autoRenew: false,
      manualPaymentRequired: true,
      graceEndsAt: admin.firestore.Timestamp.fromDate(graceEndsAt),
      nextRenewalAttemptAt: admin.firestore.FieldValue.delete(),
      renewalChargeLock: admin.firestore.FieldValue.delete(),
      lastChargeStatus: reason,
      lastChargeAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true }),
    db.collection('users').doc(studentId).set({
      paymentCompleted: false,
      subscriptionStatus: 'past_due',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true }),
  ]);
};

const markUncertainAttempt = async ({ db, studentId, subscription, dueDate, attemptNumber, error }) => {
  const attempt = subscription.renewalAttempt ?? {};
  const reference = attempt.reference || `renewal-${studentId}-${dueDate.getTime()}-${attemptNumber}`;
  const selectedPlan = attempt.planId
    ? attempt
    : (subscription.pendingPlan?.planId ? subscription.pendingPlan : subscription);
  const graceEndsAt = renewalGraceEnd(dueDate);
  const retryDate = new Date(Date.now() + RETRY_DELAY_HOURS * 60 * 60 * 1000);

  await Promise.all([
    db.collection('subscriptions').doc(studentId).set({
      status: 'past_due',
      autoRenew: false,
      manualPaymentRequired: false,
      renewalAttemptCount: Math.max(Number(subscription.renewalAttemptCount) || 0, attemptNumber),
      renewalAttempt: {
        ...attempt,
        reference,
        attemptNumber,
        renewalDate: admin.firestore.Timestamp.fromDate(dueDate),
        status: 'unknown',
        startedAt: attempt.startedAt || admin.firestore.Timestamp.now(),
        updatedAt: admin.firestore.Timestamp.now(),
      },
      graceEndsAt: admin.firestore.Timestamp.fromDate(graceEndsAt),
      nextRenewalAttemptAt: admin.firestore.Timestamp.fromDate(retryDate),
      renewalChargeLock: admin.firestore.FieldValue.delete(),
      lastChargeStatus: 'verification_pending',
      lastChargeError: String(error?.message ?? error ?? 'Charge outcome could not be confirmed').slice(0, 240),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true }),
    db.collection('users').doc(studentId).set({
      paymentCompleted: false,
      subscriptionStatus: 'past_due',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true }),
    db.collection('payments').doc(reference).set({
      reference,
      studentId,
      payerId: attempt.payerId || studentId,
      status: 'processing',
      recurring: true,
      attemptNumber,
      planId: selectedPlan.planId,
      billingPeriod: selectedPlan.billingPeriod,
      subjectCount: selectedPlan.subjectCount,
      amount: selectedPlan.amount ?? subscription.amount ?? 0,
      currency: selectedPlan.currency ?? subscription.currency ?? 'ZAR',
      verificationPending: true,
      lastVerificationError: String(error?.message ?? error ?? 'Charge outcome could not be confirmed').slice(0, 240),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true }),
  ]);
};

const getAttemptQuote = (subscription) => {
  const attempt = subscription.renewalAttempt ?? {};
  const plan = attempt.planId
    ? attempt
    : (subscription.pendingPlan?.planId ? subscription.pendingPlan : subscription);
  return calculateSubscriptionQuote({
    planId: plan.planId,
    billingPeriod: plan.billingPeriod,
    subjectCount: plan.subjectCount,
  });
};

export const processSubscriptionRenewals = onSchedule(
  {
    schedule: 'every day 01:00',
    timeZone: 'Africa/Johannesburg',
    cpu: 'gcf_gen1',
  },
  async () => {
    const db = getDb();
    const now = new Date();
    const dueSnapshot = await db.collection('subscriptions').where('renewalDate', '<=', now).get();
    logger.info('Found subscriptions due for renewal or expiry', { count: dueSnapshot.size });

    for (const subscriptionDoc of dueSnapshot.docs) {
      const subscription = subscriptionDoc.data();
      const studentId = subscription.studentId || subscriptionDoc.id;
      const dueDate = subscription.renewalDate?.toDate?.() ?? null;
      if (!studentId || !dueDate || dueDate > now || subscription.planId === 'free') continue;
      if (!['active', 'past_due'].includes(subscription.status)) continue;

      const attemptDate = subscription.renewalAttempt?.renewalDate?.toDate?.();
      const inFlightAttempt = isInFlight(subscription.renewalAttempt)
        && attemptDate?.getTime() === dueDate.getTime();

      if (inFlightAttempt) {
        try {
          const authorizationSnapshot = await db.collection('subscriptionAuthorizations').doc(studentId).get();
          const authorization = authorizationSnapshot.exists ? authorizationSnapshot.data() : null;
          const quote = getAttemptQuote(subscription);
          const result = await chargeAuthorizationForSubscription({
            studentId,
            payerId: subscription.renewalAttempt.payerId || authorization?.payerId || studentId,
            email: authorization?.email || subscription.renewalAttempt.email || '',
            amount: quote.amount,
            authorizationCode: authorization?.authorizationCode || '',
            subscriptionQuote: quote,
            renewalDate: subscription.renewalDate,
            pendingPlanReference: subscription.renewalAttempt.pendingPlanReference ?? null,
            attemptNumber: subscription.renewalAttempt.attemptNumber,
            reference: subscription.renewalAttempt.reference,
          });

          if (result.succeeded) {
            logger.info('Uncertain subscription charge was verified successfully', { studentId, reference: result.reference });
            continue;
          } else if (result.processing || result.skipped) {
            logger.info('Subscription charge is still awaiting verification', { studentId, reason: result.reason });
            continue;
          } else {
            logger.warn('Uncertain subscription charge was verified as unsuccessful', { studentId, reference: result.reference });
          }
        } catch (error) {
          logger.error('Could not verify uncertain subscription charge', { studentId, error: error?.message ?? String(error) });
          await markUncertainAttempt({
            db,
            studentId,
            subscription,
            dueDate,
            attemptNumber: Number(subscription.renewalAttempt.attemptNumber) || 1,
            error,
          });
          continue;
        }

        if (subscription.cancelAtPeriodEnd || subscription.pendingPlan?.planId === 'free') {
          await applyFreeSubscription({
            studentId,
            pendingReference: subscription.pendingPlanReference ?? null,
            pendingStatus: subscription.pendingPlan?.planId === 'free' ? 'applied' : 'cancelled',
            reason: subscription.cancelAtPeriodEnd ? 'cancelled_at_period_end' : 'scheduled_free_change',
          });
          continue;
        }

        if (renewalGraceEnd(dueDate) <= now) {
          await applyFreeSubscription({ studentId, pendingStatus: 'expired', reason: 'renewal_grace_expired' });
        }
        continue;
      }

      if (subscription.pendingPlan?.planId === 'free' || subscription.cancelAtPeriodEnd === true) {
        try {
          await applyFreeSubscription({
            studentId,
            pendingReference: subscription.pendingPlanReference ?? null,
            pendingStatus: subscription.pendingPlan?.planId === 'free' ? 'applied' : 'cancelled',
            reason: subscription.cancelAtPeriodEnd ? 'cancelled_at_period_end' : 'scheduled_free_change',
          });
        } catch (error) {
          logger.error('Could not apply scheduled Free transition', { studentId, error: error?.message ?? String(error) });
        }
        continue;
      }

      const graceEndsAt = subscription.graceEndsAt?.toDate?.() ?? renewalGraceEnd(dueDate);
      if (graceEndsAt <= now) {
        try {
          await applyFreeSubscription({
            studentId,
            pendingReference: subscription.pendingPlanReference ?? null,
            pendingStatus: 'expired',
            reason: 'renewal_grace_expired',
          });
        } catch (error) {
          logger.error('Could not expire past-due subscription', { studentId, error: error?.message ?? String(error) });
        }
        continue;
      }

      if (subscription.autoRenew !== true) {
        await setManualPaymentRequired({
          db,
          studentId,
          dueDate,
          reason: subscription.lastChargeStatus || 'manual_payment_required',
        });
        continue;
      }

      const nextAttemptAt = subscription.nextRenewalAttemptAt?.toDate?.();
      if (nextAttemptAt && nextAttemptAt > now) continue;

      const authorizationSnapshot = await db.collection('subscriptionAuthorizations').doc(studentId).get();
      const authorization = authorizationSnapshot.exists ? authorizationSnapshot.data() : null;
      if (authorization?.reusable !== true || !authorization.authorizationCode || !authorization.email) {
        await setManualPaymentRequired({
          db,
          studentId,
          dueDate,
          reason: authorizationSnapshot.exists ? 'authorization_not_reusable' : 'missing_authorization',
        });
        continue;
      }

      let quote;
      try {
        quote = calculateSubscriptionQuote({
          planId: subscription.pendingPlan?.planId || subscription.planId,
          billingPeriod: subscription.pendingPlan?.billingPeriod || subscription.billingPeriod,
          subjectCount: subscription.pendingPlan?.subjectCount ?? subscription.subjectCount,
        });
      } catch (error) {
        logger.error('Subscription plan could not be priced for renewal', { studentId, error: error.message });
        await setManualPaymentRequired({ db, studentId, dueDate, reason: 'invalid_saved_plan' });
        continue;
      }

      const attemptNumber = (Number(subscription.renewalAttemptCount) || 0) + 1;
      if (attemptNumber > MAX_RENEWAL_ATTEMPTS) {
        await setManualPaymentRequired({ db, studentId, dueDate, reason: 'renewal_attempts_exhausted' });
        continue;
      }

      try {
        const result = await chargeAuthorizationForSubscription({
          studentId,
          payerId: authorization.payerId || studentId,
          email: authorization.email,
          amount: quote.amount,
          authorizationCode: authorization.authorizationCode,
          subscriptionQuote: quote,
          renewalDate: subscription.renewalDate,
          pendingPlanReference: subscription.pendingPlanReference ?? null,
          attemptNumber,
        });
        if (result.skipped) {
          logger.info('Subscription renewal attempt was safely skipped', { studentId, reason: result.reason });
        } else if (result.succeeded) {
          logger.info('Subscription renewed successfully', { studentId, reference: result.reference });
        } else {
          logger.warn('Subscription renewal needs another attempt or verification', {
            studentId,
            reference: result.reference,
            attemptNumber,
            processing: result.processing,
          });
        }
      } catch (error) {
        logger.error('Subscription renewal outcome needs verification', { studentId, error: error?.message ?? String(error) });
        const latestSnapshot = await db.collection('subscriptions').doc(studentId).get();
        await markUncertainAttempt({
          db,
          studentId,
          subscription: latestSnapshot.exists ? latestSnapshot.data() : subscription,
          dueDate,
          attemptNumber,
          error,
        });
      }
    }
  }
);
