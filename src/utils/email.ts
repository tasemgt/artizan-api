// Dev:  Mailtrap sandbox — all emails caught, nothing sent to real users
// Prod: Resend — real transactional delivery
// Same interface either way: sendEmail(options)

import nodemailer from "nodemailer";
import { Resend } from "resend";

const APP_NAME = "Artizan";
const FROM = process.env.EMAIL_FROM ?? "noreply@artizan.app";

// ── Branded HTML wrapper ──────────────────────────────────────────────
const brandedHtml = (body: string) => `
<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">
  <div style="background:linear-gradient(135deg,#3A1A6E,#5B2D8E);
              padding:28px 24px;text-align:center;
              border-radius:8px 8px 0 0">
    <h1 style="color:#fff;margin:0;font-size:26px;
               letter-spacing:-0.5px;font-weight:700">
      ${APP_NAME}
    </h1>
  </div>
  <div style="background:#fff;padding:32px;
              border-radius:0 0 8px 8px;
              border:1px solid #e0e0e0">
    ${body}
  </div>
  <p style="text-align:center;color:#bbb;font-size:12px;margin-top:16px">
    © ${new Date().getFullYear()} ${APP_NAME}. All rights reserved.
  </p>
</div>`;

interface EmailOptions {
  email: string;
  subject: string;
  message: string;
  html?: string;
}

// ── Dev transport: Mailtrap sandbox ──────────────────────────────────
const createMailtrapTransport = () =>
  nodemailer.createTransport({
    host: process.env.MAILTRAP_HOST ?? "sandbox.smtp.mailtrap.io",
    port: parseInt(process.env.MAILTRAP_PORT ?? "2525", 10),
    auth: {
      user: process.env.MAILTRAP_USER ?? "",
      pass: process.env.MAILTRAP_PASS ?? "",
    },
  });

const sendEmailDev = async (options: EmailOptions): Promise<void> => {
  const transporter = createMailtrapTransport();
  await transporter.sendMail({
    from: `${APP_NAME} <${FROM}>`,
    to: options.email,
    subject: options.subject,
    text: options.message,
    html: options.html ?? options.message.replace(/\n/g, "<br>"),
  });
  console.log(
    `📧 [Mailtrap] Email sent to ${options.email} — "${options.subject}"`,
  );
};

// ── Prod transport: Resend ────────────────────────────────────────────
const sendEmailProd = async (options: EmailOptions): Promise<void> => {
  const resend = new Resend(process.env.RESEND_API_KEY ?? "");
  const { error } = await resend.emails.send({
    from: `${APP_NAME} <${FROM}>`,
    to: options.email,
    subject: options.subject,
    text: options.message,
    html: options.html ?? options.message.replace(/\n/g, "<br>"),
  });
  // Resend's SDK resolves normally (does not throw) on API-level failures
  // (bad/missing key, unverified sending domain, etc.) - without this check
  // a failed send looks identical to a successful one to every caller.
  if (error) {
    throw new Error(`Resend failed to send email to ${options.email}: ${error.name} - ${error.message}`);
  }
  console.log(`📧 [Resend] Email sent to ${options.email}`);
};

// EMAIL_PROVIDER decouples transport choice from NODE_ENV - deployed
// environments still need to test signups against Mailtrap before a real
// sending domain is verified with Resend. Falls back to the NODE_ENV-based
// default when unset, so existing local/.env setups are unaffected.
const emailProvider =
  process.env.EMAIL_PROVIDER ??
  (process.env.NODE_ENV === "production" ? "resend" : "mailtrap");

const sendEmail = emailProvider === "resend" ? sendEmailProd : sendEmailDev;

export default sendEmail;

// ── Convenience senders ───────────────────────────────────────────────

export const sendOtpEmail = async (
  email: string,
  firstName: string,
  otp: string,
  purpose: "verify" | "reset" = "verify",
): Promise<void> => {
  const isReset = purpose === "reset";
  const subject = isReset
    ? `${otp} — Reset your ${APP_NAME} password`
    : `${otp} — Verify your ${APP_NAME} account`;
  const headline = isReset ? "Reset your password" : "Verify your email";
  const bodyText = isReset
    ? "Use the code below to reset your password."
    : "Use the code below to verify your email address.";

  await sendEmail({
    email,
    subject,
    message: `Hi ${firstName},\n\nYour ${APP_NAME} code is: ${otp}\n\nExpires in 10 minutes.\n\nIf you didn't request this, ignore this email.`,
    html: brandedHtml(`
      <p style="font-size:16px;color:#212121;margin-bottom:6px">
        Hi ${firstName},
      </p>
      <p style="color:#555;margin-bottom:24px">${bodyText}</p>

      <div style="background:#EDE7F6;border-radius:10px;
                  padding:28px 16px;text-align:center;margin-bottom:24px">
        <p style="margin:0 0 6px;font-size:13px;color:#7E57C2;
                  letter-spacing:1px;text-transform:uppercase;
                  font-weight:600">
          Your code
        </p>
        <span style="font-size:40px;font-weight:800;letter-spacing:14px;
                     color:#5B2D8E;font-family:monospace">
          ${otp}
        </span>
      </div>

      <p style="color:#999;font-size:13px;text-align:center">
        This code expires in <strong>10 minutes</strong>.
        If you didn't request this, you can safely ignore this email.
      </p>
    `),
  });
};

export const sendPasswordChangedEmail = async (
  email: string,
  firstName: string,
): Promise<void> => {
  await sendEmail({
    email,
    subject: `Your ${APP_NAME} password was changed`,
    message: `Hi ${firstName},\n\nYour password was updated successfully.\n\nIf you didn't do this, contact support immediately.`,
    html: brandedHtml(`
      <p style="font-size:16px;color:#212121">Hi ${firstName},</p>
      <p style="color:#555">Your ${APP_NAME} password was updated successfully.</p>
      <p style="color:#c62828;font-size:13px">
        If you did not make this change, please contact support immediately.
      </p>
    `),
  });
};