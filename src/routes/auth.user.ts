import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import crypto from "crypto";
import { prisma } from "../server";
import { hashPassword, verifyPassword, ok, fail } from "../utils/helpers";
import { signTokens, sanitiseUser } from "../services/authService";
import { sendOtpEmail, sendPasswordChangedEmail } from "../utils/email";
import { createOtp, verifyOtp } from "../utils/otp";
import { verifyJwt } from "../middleware/auth";

// ── Schemas ───────────────────────────────────────────────────────────
const registerSchema = z.object({
  firstName: z.string().min(1).max(50),
  lastName: z.string().min(1).max(50),
  email: z.string().email(),
  phoneNumber: z.string().min(10).max(20),
  password: z.string().min(8).max(128),
  profileImageUrl: z.string().url().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const verifyEmailSchema = z.object({
  email: z.string().email(),
  code: z.string().length(6),
});

const resendOtpSchema = z.object({
  email: z.string().email(),
  purpose: z.enum(["verify", "reset"]),
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  email: z.string().email(),
  code: z.string().length(6),
  password: z.string().min(8).max(128),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(128),
});

// ── Plugin ────────────────────────────────────────────────────────────
const authUserRoutes: FastifyPluginAsync = async (app) => {
  // ── POST /register ────────────────────────────────────────────────
  app.post("/register", async (req, reply) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send(
          fail(
            "VALIDATION_ERROR",
            "Invalid input.",
            parsed.error.flatten().fieldErrors,
          ),
        );
    }
    const {
      firstName,
      lastName,
      email,
      phoneNumber,
      password,
      profileImageUrl,
    } = parsed.data;

    // Duplicate check
    const existing = await prisma.user.findFirst({
      where: { OR: [{ email }, { phoneNumber }] },
    });
    if (existing) {
      const field = existing.email === email ? "Email" : "Phone number";
      return reply
        .status(409)
        .send(fail("DUPLICATE", `${field} is already registered.`));
    }

    const passwordHash = await hashPassword(password);

    // Create user + wallet + OTP and send the verification email all inside
    // one transaction - if the email send throws (bad creds, unverified
    // Resend domain, etc.), everything rolls back rather than leaving an
    // orphaned user row that can never be re-registered or verified.
    const user = await prisma.$transaction(
      async (tx) => {
        const created = await tx.user.create({
          data: {
            firstName,
            lastName,
            email,
            phoneNumber,
            passwordHash,
            profileImageUrl: profileImageUrl ?? null,
            wallet: {
              create: {
                ownerId: crypto.randomUUID(),
                ownerType: "USER",
                balance: 0,
                xpPoints: 0,
                currency: "NGN",
              },
            },
          },
          include: { wallet: true },
        });

        const code = await createOtp(email, "verify", tx);
        await sendOtpEmail(email, firstName, code, "verify");

        return created;
      },
      { timeout: 15000 },
    );

    return reply.status(201).send(
      ok({
        user: sanitiseUser(user),
        message: `Verification code sent to ${email}`,
      }),
    );
  });

  // ── POST /verify-email ────────────────────────────────────────────
  app.post("/verify-email", async (req, reply) => {
    const parsed = verifyEmailSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send(fail("VALIDATION_ERROR", "Email and 6-digit code required."));
    }
    const { email, code } = parsed.data;

    const verified = await prisma.$transaction(async (tx) => {
      const valid = await verifyOtp(email, code, "verify", tx);
      if (!valid) return false;
      await tx.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
      return true;
    });
    if (!verified) {
      return reply
        .status(400)
        .send(
          fail("INVALID_OTP", "Invalid or expired code. Please try again."),
        );
    }

    return reply.send(ok({ message: "Email verified successfully." }));
  });

  // ── POST /resend-otp ──────────────────────────────────────────────
  app.post("/resend-otp", async (req, reply) => {
    const parsed = resendOtpSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send(fail("VALIDATION_ERROR", "Email and purpose required."));
    }
    const { email, purpose } = parsed.data;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      // Return success to prevent email enumeration
      return reply.send(
        ok({ message: "If that email exists, a code has been sent." }),
      );
    }

    const code = await createOtp(email, purpose);
    await sendOtpEmail(email, user.firstName, code, purpose);

    return reply.send(ok({ message: `New code sent to ${email}` }));
  });

  // ── POST /login ───────────────────────────────────────────────────
  app.post("/login", { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send(fail("VALIDATION_ERROR", "Invalid input."));
    }
    const { email, password } = parsed.data;

    const user = await prisma.user.findFirst({
      where: { email, isActive: true, deletedAt: null },
    });

    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return reply
        .status(401)
        .send(fail("INVALID_CREDENTIALS", "Incorrect email or password."));
    }

    if (!user.emailVerifiedAt) {
      // Resend verification OTP so they can verify right away
      const code = await createOtp(email, "verify");
      await sendOtpEmail(email, user.firstName, code, "verify");
      return reply
        .status(403)
        .send(
          fail(
            "EMAIL_NOT_VERIFIED",
            "Please verify your email. A new code has been sent.",
          ),
        );
    }

    const { token, refreshToken } = signTokens(app, {
      id: user.id,
      role: "user",
    });
    return reply.send(ok({ token, refreshToken, user: sanitiseUser(user) }));
  });

  // ── POST /logout ──────────────────────────────────────────────────
  app.post("/logout", { preHandler: verifyJwt }, async (_req, reply) => {
    return reply.send(ok({ message: "Logged out successfully." }));
  });

  // ── POST /refresh ─────────────────────────────────────────────────
  app.post("/refresh", async (req, reply) => {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send(fail("VALIDATION_ERROR", "Refresh token required."));
    }
    try {
      const decoded = app.jwt.verify(parsed.data.refreshToken) as any;
      if (decoded.type !== "refresh") throw new Error("Not a refresh token");
      const user = await prisma.user.findFirst({
        where: { id: decoded.id, isActive: true, deletedAt: null },
      });
      if (!user)
        return reply.status(401).send(fail("UNAUTHORIZED", "Invalid session."));
      const { token, refreshToken } = signTokens(app, {
        id: user.id,
        role: "user",
      });
      return reply.send(ok({ token, refreshToken }));
    } catch {
      return reply
        .status(401)
        .send(fail("UNAUTHORIZED", "Invalid or expired refresh token."));
    }
  });

  // ── POST /forgot-password ─────────────────────────────────────────
  app.post("/forgot-password", { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req, reply) => {
    const parsed = forgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send(fail("VALIDATION_ERROR", "Email required."));
    }
    const { email } = parsed.data;

    const user = await prisma.user.findUnique({ where: { email } });
    // Always return success — prevent email enumeration
    if (!user) {
      return reply.send(
        ok({ message: "If that email exists, a reset code has been sent." }),
      );
    }

    const code = await createOtp(email, "reset");
    await sendOtpEmail(email, user.firstName, code, "reset");

    return reply.send(ok({ message: "Reset code sent to your email." }));
  });

  // ── POST /reset-password ──────────────────────────────────────────
  app.post("/reset-password", async (req, reply) => {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send(
          fail(
            "VALIDATION_ERROR",
            "Email, 6-digit code, and new password required.",
          ),
        );
    }
    const { email, code, password } = parsed.data;
    const passwordHash = await hashPassword(password);

    const user = await prisma.$transaction(async (tx) => {
      const valid = await verifyOtp(email, code, "reset", tx);
      if (!valid) return null;
      return tx.user.update({
        where: { email },
        data: { passwordHash, passwordChangedAt: new Date() },
      });
    });
    if (!user) {
      return reply
        .status(400)
        .send(fail("INVALID_OTP", "Invalid or expired code."));
    }

    await sendPasswordChangedEmail(email, user.firstName);
    const { token, refreshToken } = signTokens(app, {
      id: user.id,
      role: "user",
    });
    return reply.send(ok({ token, refreshToken, user: sanitiseUser(user) }));
  });

  // ── PATCH /change-password (authenticated) ────────────────────────
  app.patch(
    "/change-password",
    { preHandler: verifyJwt },
    async (req, reply) => {
      const parsed = changePasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send(fail("VALIDATION_ERROR", "Current and new password required."));
      }
      const { currentPassword, newPassword } = parsed.data;

      const user = await prisma.user.findUnique({
        where: { id: (req as any).authUser.id },
      });
      if (!user)
        return reply.status(404).send(fail("NOT_FOUND", "User not found."));

      const valid = await verifyPassword(currentPassword, user.passwordHash);
      if (!valid) {
        return reply
          .status(401)
          .send(fail("INVALID_PASSWORD", "Current password is incorrect."));
      }

      const passwordHash = await hashPassword(newPassword);
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash, passwordChangedAt: new Date() },
      });

      await sendPasswordChangedEmail(user.email, user.firstName);
      return reply.send(ok({ message: "Password changed successfully." }));
    },
  );
};

export default authUserRoutes;