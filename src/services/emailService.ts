// src/services/emailService.ts
// Transactional email via Resend. Handles: email verification, password reset, receipts.

import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY ?? '');
const FROM   = process.env.EMAIL_FROM ?? 'noreply@artizan.app';
const APP_NAME = 'Artizan';

export async function sendEmailVerification(email: string, code: string, firstName: string) {
  try {
    await resend.emails.send({
      from:    FROM,
      to:      email,
      subject: `${code} — Verify your ${APP_NAME} account`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto">
          <div style="background:#5B2D8E;padding:24px;text-align:center;border-radius:8px 8px 0 0">
            <h1 style="color:#fff;margin:0;font-size:24px">${APP_NAME}</h1>
          </div>
          <div style="background:#fff;padding:32px;border-radius:0 0 8px 8px;border:1px solid #e0e0e0">
            <p style="font-size:16px;color:#212121">Hi ${firstName},</p>
            <p style="color:#555">Thanks for joining ${APP_NAME}! Use the code below to verify your email address.</p>
            <div style="background:#EDE7F6;border-radius:8px;padding:24px;text-align:center;margin:24px 0">
              <span style="font-size:36px;font-weight:bold;letter-spacing:10px;color:#5B2D8E">${code}</span>
            </div>
            <p style="color:#999;font-size:13px">This code expires in 30 minutes. If you didn't create an account, ignore this email.</p>
          </div>
        </div>
      `,
    });
  } catch (err) {
    console.error('[Email] Failed to send verification:', err);
  }
}

export async function sendPasswordReset(email: string, resetToken: string, firstName: string) {
  const resetUrl = `artizan://reset-password?token=${resetToken}`;
  try {
    await resend.emails.send({
      from:    FROM,
      to:      email,
      subject: `Reset your ${APP_NAME} password`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto">
          <div style="background:#5B2D8E;padding:24px;text-align:center;border-radius:8px 8px 0 0">
            <h1 style="color:#fff;margin:0;font-size:24px">${APP_NAME}</h1>
          </div>
          <div style="background:#fff;padding:32px;border-radius:0 0 8px 8px;border:1px solid #e0e0e0">
            <p style="font-size:16px;color:#212121">Hi ${firstName},</p>
            <p style="color:#555">We received a request to reset your ${APP_NAME} password.</p>
            <a href="${resetUrl}"
               style="display:inline-block;background:#5B2D8E;color:#fff;padding:14px 28px;border-radius:50px;text-decoration:none;font-weight:bold;margin:24px 0">
              Reset Password
            </a>
            <p style="color:#999;font-size:13px">This link expires in 15 minutes. If you didn't request this, ignore this email.</p>
          </div>
        </div>
      `,
    });
  } catch (err) {
    console.error('[Email] Failed to send password reset:', err);
  }
}
