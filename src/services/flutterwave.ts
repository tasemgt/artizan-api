// src/services/flutterwave.ts
// Flutterwave Standard (hosted checkout) integration for wallet funding.
// Test mode vs live is purely a matter of which secret key is in .env
// (FLWSECK_TEST-... vs FLWSECK-...) — no code branching needed to switch.

const FLW_BASE_URL = 'https://api.flutterwave.com/v3';

function getSecretKey(): string {
  const key = process.env.FLUTTERWAVE_SECRET_KEY;
  if (!key) throw new Error('FLUTTERWAVE_SECRET_KEY is not configured.');
  return key;
}

interface InitiatePaymentInput {
  txRef: string;
  amount: number;
  redirectUrl: string;
  customerEmail: string;
  customerName: string;
}

// Creates a hosted checkout session and returns the payment link the user
// is redirected to (opened in-app via expo-web-browser on the mobile side).
export async function initiatePayment({
  txRef, amount, redirectUrl, customerEmail, customerName,
}: InitiatePaymentInput): Promise<string> {
  const res = await fetch(`${FLW_BASE_URL}/payments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getSecretKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      tx_ref: txRef,
      amount,
      currency: 'NGN',
      redirect_url: redirectUrl,
      customer: { email: customerEmail, name: customerName },
      customizations: { title: 'Artizan Wallet Top-up' },
    }),
  });

  const json: any = await res.json();
  if (!res.ok || json.status !== 'success') {
    throw new Error(json?.message ?? `Flutterwave payment initiation failed (${res.status}).`);
  }
  return json.data.link as string;
}

interface VerifiedTransaction {
  status: 'successful' | 'failed' | string;
  amount: number;
  currency: string;
  txRef: string;
}

// Called from BOTH the redirect callback and the webhook — always re-verify
// against Flutterwave directly rather than trusting query params/payload at
// face value (the standard, mandatory anti-fraud practice for this API).
export async function verifyTransaction(transactionId: string): Promise<VerifiedTransaction> {
  const res = await fetch(`${FLW_BASE_URL}/transactions/${transactionId}/verify`, {
    headers: { Authorization: `Bearer ${getSecretKey()}` },
  });
  const json: any = await res.json();
  if (!res.ok || json.status !== 'success') {
    throw new Error(json?.message ?? `Flutterwave verification failed (${res.status}).`);
  }
  return {
    status:   json.data.status,
    amount:   json.data.amount,
    currency: json.data.currency,
    txRef:    json.data.tx_ref,
  };
}
