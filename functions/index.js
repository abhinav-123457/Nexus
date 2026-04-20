const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();

async function getDispatchWebhookUrl() {
  const config = await db.collection('appConfig').doc('dispatchWebhook').get();
  const url = config.data()?.url;
  return typeof url === 'string' ? url.trim() : '';
}

async function enqueueRetryFromDispatch(dispatchId, payload, errorMessage) {
  await db.collection('retryQueue').add({
    action: 'dispatch_to_external_service',
    status: 'pending',
    payload: {
      dispatchId,
      ...payload,
    },
    error: errorMessage,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

exports.notifyAssignedStaff = functions.firestore
  .document('incidents/{incidentId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after = change.after.data();

    // Only trigger when staff gets assigned (assignedStaff array changed)
    const beforeIds = before.assignedStaff || [];
    const afterIds = after.assignedStaff || [];
    if (afterIds.length === 0 || afterIds.length === beforeIds.length) return;

    // Get FCM tokens for newly assigned staff
    const tokens = [];
    for (const id of afterIds) {
      const doc = await admin.firestore().collection('staff').doc(id).get();
      const token = doc.data()?.fcmToken;
      if (token) tokens.push(token);
    }

    if (tokens.length === 0) return;

    await admin.messaging().sendEachForMulticast({
      tokens,
      notification: {
        title: `NEXUS — ${after.type.toUpperCase()} ALERT`,
        body: `You are assigned to ${after.zone}. Respond immediately.`,
      },
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId: 'nexus_alerts',
          color: '#E63946',
        },
      },
      data: {
        incidentId: context.params.incidentId,
        type: after.type,
        zone: after.zone,
      },
    });

    return null;
  });

exports.processDispatchQueue = functions.firestore
  .document('dispatchQueue/{dispatchId}')
  .onCreate(async (snap, context) => {
    const data = snap.data() || {};
    if ((data.status || 'pending') !== 'pending') return null;

    const payload = {
      incidentId: data.incidentId || '',
      type: data.type || 'unknown',
      severity: data.severity || 'high',
      zone: data.zone || 'unknown',
      description: data.description || '',
      triggeredBy: data.triggeredBy || '',
      source: 'nexus',
    };

    try {
      const webhookUrl = await getDispatchWebhookUrl();
      if (!webhookUrl) {
        throw new Error('Dispatch webhook URL is not configured');
      }

      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`Webhook HTTP ${response.status}`);
      }

      await snap.ref.update({
        status: 'sent',
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      if (payload.incidentId) {
        await db
          .collection('incidents')
          .doc(payload.incidentId)
          .collection('events')
          .add({
            type: 'external_dispatch_sent',
            actor: 'cloud_function',
            details: {dispatchId: context.params.dispatchId},
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
      }
    } catch (error) {
      await snap.ref.update({
        status: 'failed',
        attempts: admin.firestore.FieldValue.increment(1),
        note: String(error),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await enqueueRetryFromDispatch(
        context.params.dispatchId,
        payload,
        String(error),
      );
    }

    return null;
  });

exports.enforceIncidentSla = functions.firestore
  .document('incidents/{incidentId}')
  .onWrite(async (change, context) => {
    if (!change.after.exists) return null;
    const after = change.after.data() || {};
    if ((after.status || '') === 'resolved') return null;

    const triggeredAt = after.triggeredAt;
    if (!triggeredAt || typeof triggeredAt.toMillis !== 'function') return null;

    const nowMs = Date.now();
    const ageMs = nowMs - triggeredAt.toMillis();
    const incidentId = context.params.incidentId;
    const assigned = Array.isArray(after.assignedStaff) ? after.assignedStaff : [];

    // SLA 1: escalation when no staff assigned after 2 minutes.
    if (assigned.length === 0 && ageMs > 2 * 60 * 1000 && !after.escalatedNoAssignmentAt) {
      await db.collection('dispatchQueue').add({
        incidentId,
        type: 'escalation_no_assignment',
        severity: after.severity || 'high',
        zone: after.zone || 'unknown',
        description: after.description || 'No staff assigned within SLA',
        triggeredBy: 'sla_guard',
        status: 'pending',
        attempts: 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await change.after.ref.update({
        escalatedNoAssignmentAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return null;
    }

    // SLA 2: escalation when assigned but no acknowledgement after 3 minutes.
    if (
      assigned.length > 0 &&
      ageMs > 3 * 60 * 1000 &&
      !after.firstAcknowledgedAt &&
      !after.escalatedAckTimeoutAt
    ) {
      await db.collection('dispatchQueue').add({
        incidentId,
        type: 'escalation_ack_timeout',
        severity: after.severity || 'high',
        zone: after.zone || 'unknown',
        description: after.description || 'No acknowledgement within SLA',
        triggeredBy: 'sla_guard',
        status: 'pending',
        attempts: 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await change.after.ref.update({
        escalatedAckTimeoutAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    return null;
  });

exports.trackAcknowledgement = functions.firestore
  .document('incidents/{incidentId}/acks/{ackId}')
  .onWrite(async (change, context) => {
    if (!change.after.exists) return null;
    const before = change.before.exists ? change.before.data() || {} : {};
    const after = change.after.data() || {};

    if (before.status === 'acknowledged' || after.status !== 'acknowledged') {
      return null;
    }

    const incidentRef = db.collection('incidents').doc(context.params.incidentId);
    await db.runTransaction(async (tx) => {
      const incidentSnap = await tx.get(incidentRef);
      if (!incidentSnap.exists) return;
      const incidentData = incidentSnap.data() || {};
      if (!incidentData.firstAcknowledgedAt) {
        tx.update(incidentRef, {
          firstAcknowledgedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    });

    await incidentRef.collection('events').add({
      type: 'staff_acknowledged',
      actor: after.staffId || context.params.ackId,
      details: {},
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return null;
  });