import { Router } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import prisma from "../prisma.js";
import crypto from "crypto";

const router = Router();

// ─── Register ─────────────────────────────────────────────────────────────────
router.post("/register", async (req, res) => {
    const { name, email, username, password } = req.body;

    if (!name || !email || !username || !password) {
        return res.status(400).json({ error: "All fields are required" });
    }

    try {
        const existing = await prisma.user.findFirst({
            where: {
                OR: [{ email }, { username }],
            },
        });

        if (existing) {
            const field = existing.email === email ? "email" : "username";
            return res.status(409).json({ error: `This ${field} is already taken` });
        }

        const passwordHash = await bcrypt.hash(password, 10);

        const user = await prisma.user.create({
            data: { name, email, username, passwordHash },
        });

        return res.status(201).json({ success: true, userId: user.id });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Server error" });
    }
});

// ─── Login ────────────────────────────────────────────────────────────────────
router.post("/login", async (req, res) => {
    const { identifier, password } = req.body;

    if (!identifier || !password) {
        return res.status(400).json({ error: "All fields are required" });
    }

    try {
        const user = await prisma.user.findFirst({
            where: {
                OR: [{ email: identifier }, { username: identifier }],
            },
        });

        if (!user) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        const match = await bcrypt.compare(password, user.passwordHash);

        if (!match) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        const token = jwt.sign(
            { userId: user.id },
            process.env.JWT_SECRET,
            { expiresIn: "7d" }
        );

        // Set HttpOnly cookie so clients can opt into cookie-based auth.
        try {
            res.cookie("token", token, {
                httpOnly: true,
                secure: process.env.NODE_ENV === "production",
                sameSite: "lax",
                maxAge: 7 * 24 * 60 * 60 * 1000,
            });
            // Also set a non-HttpOnly CSRF token cookie (double-submit pattern)
            const csrfToken = crypto.randomBytes(24).toString("hex");
            res.cookie("csrfToken", csrfToken, {
                httpOnly: false,
                secure: process.env.NODE_ENV === "production",
                sameSite: "lax",
                maxAge: 7 * 24 * 60 * 60 * 1000,
            });
        } catch (e) {
            // ignore cookie set errors
        }

        return res.json({
            success: true,
            token,
            user: {
                id: user.id,
                name: user.name,
                username: user.username,
                email: user.email,
                bio: user.bio,
                profilePics: user.profilePics,
            },
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Server error" });
    }
});

// ─── Logout ───────────────────────────────────────────────────────────────────
router.post("/logout", (req, res) => {
    // Clear cookie-based tokens
    res.clearCookie("token");
    res.clearCookie("csrfToken");
    return res.json({ success: true });
});

// Disabled: insecure unauthenticated password reset. Implement a secure
// email + token-based reset flow before enabling this endpoint.
router.post("/reset-password", async (req, res) => {
    return res.status(501).json({
        error: "Not implemented. Use a secure password-reset flow (email token).",
    });
});

export default router;