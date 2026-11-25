const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../users/user');

const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret_in_env';
const DEFAULT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const REMEMBER_EXPIRES_IN = process.env.JWT_REMEMBER_EXPIRES_IN || '30d';

function signToken(user, rememberMe = false) {
    return jwt.sign(
        { id: user._id, username: user.username, role: user.role },
        JWT_SECRET,
        { expiresIn: rememberMe ? REMEMBER_EXPIRES_IN : DEFAULT_EXPIRES_IN }
    );
}

// POST /api/auth/signup
async function signup(req, res, next) {
    try {
        const {
            fullName,
            email,
            companyName,
            username,
            password,
            confirmPassword,
        } = req.body || {};

        if (!fullName || !email || !companyName || !username || !password) {
            return res.status(400).json({
                success: false,
                message: 'All fields (full name, email, company name, username, and password) are required.',
            });
        }

        if (confirmPassword !== undefined && password !== confirmPassword) {
            return res.status(400).json({
                success: false,
                message: 'Password and confirm password do not match.',
            });
        }

        if (String(password).length < 6) {
            return res.status(400).json({
                success: false,
                message: 'Password must be at least 6 characters long.',
            });
        }

        const normalizedEmail = String(email).trim().toLowerCase();
        const normalizedUsername = String(username).trim().toLowerCase();

        const existingUser = await User.findOne({
            $or: [{ email: normalizedEmail }, { username: normalizedUsername }],
        }).lean();

        if (existingUser) {
            const conflictField =
                existingUser.email === normalizedEmail ? 'Email' : 'Username';
            return res.status(409).json({
                success: false,
                message: `${conflictField} is already in use.`,
            });
        }

        const usersCount = await User.countDocuments();
        const assignedRole = usersCount === 0 ? 'SUPER_ADMIN' : 'SALES';
        const passwordHash = await bcrypt.hash(String(password), 10);

        const user = await User.create({
            fullName: String(fullName).trim(),
            email: normalizedEmail,
            companyName: String(companyName).trim(),
            username: normalizedUsername,
            passwordHash,
            role: assignedRole,
            isActive: true,
        });

        const token = signToken(user, false);

        return res.status(201).json({
            success: true,
            message: 'Account created successfully.',
            token,
            user: {
                id: user._id,
                fullName: user.fullName,
                email: user.email,
                companyName: user.companyName,
                username: user.username,
                role: user.role,
                permissions: user.permissions,
                isActive: user.isActive,
            },
        });
    } catch (err) {
        if (err && err.code === 11000) {
            const key = Object.keys(err.keyPattern || {})[0];
            const label = key === 'email' ? 'Email' : 'Username';
            return res.status(409).json({
                success: false,
                message: `${label} is already in use.`,
            });
        }
        if (next) return next(err);
        return res.status(500).json({
            success: false,
            message: 'Failed to create account.',
        });
    }
}

// POST /api/auth/login
async function login(req, res, next) {
    try {
        const { username, password, rememberMe = false } = req.body || {};

        if (!username || !password) {
            return res.status(400).json({
                success: false,
                message: 'Username and password are required.',
            });
        }

        const identifier = String(username).trim().toLowerCase();

        const user = await User.findOne({
            $or: [{ username: identifier }, { email: identifier }],
        }).select('+passwordHash');

        if (!user || !user.passwordHash) {
            return res.status(401).json({
                success: false,
                message: 'Invalid username or password.',
            });
        }

        if (!user.isActive) {
            return res.status(403).json({
                success: false,
                message: 'Account is inactive. Please contact your administrator.',
            });
        }

        const isMatch = await bcrypt.compare(String(password), user.passwordHash);
        if (!isMatch) {
            return res.status(401).json({
                success: false,
                message: 'Invalid username or password.',
            });
        }

        user.lastLoginAt = new Date();
        await user.save();

        const token = signToken(user, Boolean(rememberMe));

        return res.status(200).json({
            success: true,
            message: 'Signed in successfully.',
            token,
            user: {
                id: user._id,
                fullName: user.fullName,
                email: user.email,
                companyName: user.companyName,
                username: user.username,
                role: user.role,
                permissions: user.permissions,
                isActive: user.isActive,
                lastLoginAt: user.lastLoginAt,
            },
        });
    } catch (err) {
        if (next) return next(err);
        return res.status(500).json({
            success: false,
            message: 'Failed to sign in.',
        });
    }
}

// GET /api/auth/me
async function me(req, res) {
    return res.status(200).json({
        success: true,
        user: req.user,
    });
}

module.exports = { signup, login, me };