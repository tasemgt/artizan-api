// src/services/firebase.ts
// Firebase Admin SDK — used by the backend to:
//   1. Write status events to Firebase Realtime DB (so mobile apps receive them in real time)
//   2. Send FCM push notifications
//   3. Verify Firebase Phone Auth ID tokens

import admin from 'firebase-admin';

let firebaseApp: admin.app.App;

export function initFirebase() {
  if (admin.apps.length > 0) return;

  const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (!serviceAccountRaw) {
    console.warn('[Firebase] FIREBASE_SERVICE_ACCOUNT_KEY not set — Firebase Admin disabled');
    return;
  }

  const serviceAccount = JSON.parse(serviceAccountRaw);
  firebaseApp = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });
}

// ── Realtime Database ────────────────────────────────────────────────

export async function rtdbSet(path: string, data: any) {
  if (!admin.apps.length) return;
  await admin.database().ref(path).set(data);
}

export async function rtdbUpdate(path: string, data: any) {
  if (!admin.apps.length) return;
  await admin.database().ref(path).update(data);
}

export async function rtdbDelete(path: string) {
  if (!admin.apps.length) return;
  await admin.database().ref(path).remove();
}

// Write service request status update (received by both mobile apps)
export async function updateRequestStatus(
  userId: string,
  artisanId: string,
  status: string,
) {
  await rtdbSet(`requests/${userId}-${artisanId}/status`, {
    status,
    timestamp: Date.now(),
  });
}

// ── Push Notifications (FCM) ──────────────────────────────────────────
export async function sendPushNotification(
  fcmToken: string,
  title: string,
  body: string,
  data: Record<string, string> = {},
) {
  if (!admin.apps.length || !fcmToken) return;
  try {
    await admin.messaging().send({
      token: fcmToken,
      notification: { title, body },
      data,
      android: { priority: 'high', notification: { channelId: 'artizan_default' } },
      apns:    { payload: { aps: { badge: 1, sound: 'default' } } },
    });
  } catch (err) {
    console.error('[FCM] Push notification failed:', err);
  }
}

// ── Phone Auth token verification ─────────────────────────────────────
export async function verifyFirebaseIdToken(idToken: string) {
  if (!admin.apps.length) throw new Error('Firebase Admin not initialised');
  return admin.auth().verifyIdToken(idToken);
}
