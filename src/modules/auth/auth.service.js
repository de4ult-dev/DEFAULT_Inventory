const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const User = require('../users/user');
const RefreshToken = require('./refreshToken');
const { logAudit } = require('../../shared/services/audit.service');

const SALT_ROUNDS = Number(process.env.BCRYPT_SALT_ROUNDS || 10);
const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'change_me_access_secret';
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'change_me_refresh_secret';
const ACCESS_TTL = process.env.JWT_ACCESS_TTL || '15m';
const REFRESH_DAYS = Number(process.env.JWT_REFRESH_DAYS || 7);

async function hashPassword(plainPassword) {
    if (!plainPassword || String(plainPassword).length < 6) {
        const err = new Error('Password must be at least 6 characters.');
        err.statusCode = 400;
        throw err;
    }
    return bcrypt.hash(String(plainPassword), SALT_ROUNDS);
}

async function verifyPassword(plainPassword, passwordHash) {
    if (!plainPassword || !passwordHash) {
        return false;
    }
    return bcrypt.compare(String(plainPassword), passwordHash);
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function signAccessToken(user) {
    return jwt.sign(
        {
            sub: String(user._id),
            username: user.username,
            role: user.role,
            permissions: user.permissions || [],
        },
        ACCESS_SECRET,
        { expiresIn: ACCESS_TTL }
    );
}

function signRefreshToken(user) {
    return jwt.sign(
        {
            sub: String(user._id),
            jti: crypto.randomUUID(),
        },
        REFRESH_SECRET,
        { expiresIn: `${REFRESH_DAYS}d` }
    );
}

async function registerUser({
    name,
    username,
    password,
    role = 'SALES',
    permissions = [],
    performedBy = null,
}) {
    const cleanName = String(name || '').trim();
    const cleanUsername = String(username || '').trim().toLowerCase();

    if (!cleanName || !cleanUsername || !password) {
        const err = new Error('Name, username, and password are required.');
        err.statusCode = 400;
        throw err;
    }

    const existing = await User.findOne({ username: cleanUsername }).lean();
    if (existing) {
        const err = new Error('Username is already taken.');
        err.statusCode = 409;
        throw err;
    }

    const passwordHash = await hashPassword(password);

    const user = await User.create({
        name: cleanName,
        username: cleanUsername,
        passwordHash,
        role,
        permissions: Array.isArray(permissions) ? permissions : [],
        isActive: true,
    });

    await logAudit({
        entityType: 'User',
        entityId: user._id,
        entityNumber: user.username,
        action: 'CREATE',
        reason: 'User registered',
        before: null,
        after: {
            name: user.name,
            username: user.username,
            role: user.role,
            permissions: user.permissions,
            isActive: user.isActive,
        },
        performedBy: performedBy || user._id,
    });

    return {
        id: user._id,
        name: user.name,
        username: user.username,
        role: user.role,
        permissions: user.permissions || [],
        isActive: user.isActive,
    };
}

async function login({ username, password, ip = '' }) {
    const cleanUsername = String(username || '').trim().toLowerCase();
    if (!cleanUsername || !password) {
        const err = new Error('Username and password are required.');
        err.statusCode = 400;
        throw err;
    }

    const user = await User.findOne({ username: cleanUsername }).select('+passwordHash');
    if (!user) {
        const err = new Error('Invalid credentials.');
        err.statusCode = 401;
        throw err;
    }

    if (user.isActive === false) {
        const err = new Error('User account is inactive.');
        err.statusCode = 403;
        throw err;
    }

    const isValid = await verifyPassword(password, user.passwordHash);
    if (!isValid) {
        const err = new Error('Invalid credentials.');
        err.statusCode = 401;
        throw err;
    }

    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);
    const expiresAt = new Date(Date.now() + REFRESH_DAYS * 24 * 60 * 60 * 1000);

    await RefreshToken.create({
        userId: user._id,
        tokenHash: hashToken(refreshToken),
        expiresAt,
        createdByIp: ip,
    });

    user.lastLoginAt = new Date();
    await user.save();

    await logAudit({
        entityType: 'User',
        entityId: user._id,
        entityNumber: user.username,
        action: 'POST',
        reason: 'User login',
        before: null,
        after: { lastLoginAt: user.lastLoginAt, role: user.role },
        performedBy: user._id,
    });

    return {
        accessToken,
        refreshToken,
        user: {
            id: user._id,
            name: user.name,
            username: user.username,
            role: user.role,
            permissions: user.permissions || [],
        },
    };
}

async function refreshSession(refreshToken) {
    if (!refreshToken) {
        const err = new Error('Refresh token is required.');
        err.statusCode = 400;
        throw err;
    }

    jwt.verify(refreshToken, REFRESH_SECRET);
    const tokenDoc = await RefreshToken.findOne({
        tokenHash: hashToken(refreshToken),
        revokedAt: null,
        expiresAt: { $gt: new Date() },
    });

    if (!tokenDoc) {
        const err = new Error('Invalid or expired refresh token.');
        err.statusCode = 401;
        throw err;
    }

    const user = await User.findById(tokenDoc.userId);
    if (!user || user.isActive === false) {
        const err = new Error('User not found or inactive.');
        err.statusCode = 401;
        throw err;
    }

    return {
        accessToken: signAccessToken(user),
        user: {
            id: user._id,
            name: user.name,
            username: user.username,
            role: user.role,
            permissions: user.permissions || [],
        },
    };
}

async function logout(refreshToken, performedBy = null) {
    if (!refreshToken) return { loggedOut: true };

    await RefreshToken.findOneAndUpdate(
        { tokenHash: hashToken(refreshToken), revokedAt: null },
        { $set: { revokedAt: new Date() } }
    );

    if (performedBy) {
        await logAudit({
            entityType: 'User',
            entityId: performedBy,
            action: 'UPDATE',
            reason: 'User logout',
            before: null,
            after: { loggedOutAt: new Date() },
            performedBy,
        });
    }

    return { loggedOut: true };
}

async function changePassword({ userId, currentPassword, newPassword, performedBy = null }) {
    if (!userId || !currentPassword || !newPassword) {
        const err = new Error('userId, currentPassword, and newPassword are required.');
        err.statusCode = 400;
        throw err;
    }

    const user = await User.findById(userId).select('+passwordHash');
    if (!user) {
        const err = new Error('User not found.');
        err.statusCode = 404;
        throw err;
    }

    const isValid = await verifyPassword(currentPassword, user.passwordHash);
    if (!isValid) {
        const err = new Error('Current password is incorrect.');
        err.statusCode = 400;
        throw err;
    }

    user.passwordHash = await hashPassword(newPassword);
    await user.save();

    await logAudit({
        entityType: 'User',
        entityId: user._id,
        entityNumber: user.username,
        action: 'UPDATE',
        reason: 'Password changed',
        before: null,
        after: { passwordUpdatedAt: new Date() },
        performedBy: performedBy || user._id,
    });

    return { updated: true };
}

function authorize(allowedRoles = [], requiredPermissions = []) {
    return (req, res, next) => {
        const authUser = req.user;
        if (!authUser) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        if (authUser.role === 'SUPER_ADMIN') {
            return next();
        }

        const roleOk = allowedRoles.length === 0 || allowedRoles.includes(authUser.role);
        const userPerms = Array.isArray(authUser.permissions) ? authUser.permissions : [];
        const permOk =
            requiredPermissions.length === 0 ||
            requiredPermissions.every((p) => userPerms.includes(p));

        if (!roleOk || !permOk) {
            return res.status(403).json({ message: 'Forbidden: insufficient permissions' });
        }

        return next();
    };
}

module.exports = {
    hashPassword,
    verifyPassword,
    registerUser,
    login,
    refreshSession,
    logout,
    changePassword,
    authorize,
};