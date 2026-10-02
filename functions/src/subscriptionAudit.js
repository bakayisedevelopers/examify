import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { admin, getDb } from './admin.js';

const changed = (before, after, field) => JSON.stringify(before?.[field] ?? null) !== JSON.stringify(after?.[field] ?? null);

export const auditSubscriptionChanges = onDocumentWritten(
  { document: 'users/{studentId}/subscriptions/current', cpu: 'gcf_gen1' },
  async (event) => {
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    const after = event.data?.after?.exists ? event.data.after.data() : null;
    if (!after) return;
    const tracked = ['planId', 'status', 'billingPeriod', 'subjectCount', 'renewalDate', 'autoRenew', 'cancelAtPeriodEnd', 'latestReference'];
    const changedFields = tracked.filter((field) => changed(before, after, field));
    if (!changedFields.length) return;
    await getDb().collection('users').doc(event.params.studentId).collection('subscriptions').doc('current')
      .collection('history').add({
        studentId: event.params.studentId,
        changedFields,
        before: Object.fromEntries(changedFields.map((field) => [field, before?.[field] ?? null])),
        after: Object.fromEntries(changedFields.map((field) => [field, after?.[field] ?? null])),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
  },
);

export const auditAuthorizationChanges = onDocumentWritten(
  { document: 'users/{studentId}/subscriptionAuthorizations/current', cpu: 'gcf_gen1' },
  async (event) => {
    const after = event.data?.after?.exists ? event.data.after.data() : null;
    if (!after) return;
    await getDb().collection('users').doc(event.params.studentId).collection('subscriptionAuthorizations').doc('current')
      .collection('history').add({
        payerId: after.payerId ?? event.params.studentId,
        cardType: after.cardType ?? null,
        last4: after.last4 ?? null,
        expMonth: after.expMonth ?? null,
        expYear: after.expYear ?? null,
        reusable: after.reusable === true,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
  },
);
