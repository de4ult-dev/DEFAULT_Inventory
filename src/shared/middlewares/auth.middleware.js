const jwt = require('jsonwebtoken');
const User = require('../../modules/users/user');

const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret_in_env';

async function authMiddleware(req, res, next) {
    try {
        const authHeader = req.headers.authorization || '';
        if (!authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                success: false,
                message: 'Authentication token is missing.',
            });
        }

        const token = authHeader.slice(7).trim();
        const decoded = jwt.verify(token, JWT_SECRET);

        const user = await User.findById(decoded.id).lean();
        if (!user || !user.isActive) {
            return res.status(401).json({
                success: false,
                message: 'User not found or inactive.',
            });
        }

        req.user = user;
        return next();
    } catch {
        return res.status(401).json({
            success: false,
            message: 'Invalid or expired token.',
        });
    }
}

function authorizeRoles(...allowedRoles) {
    return (req, res, next) => {
        if (!req.user || !allowedRoles.includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                message: 'You do not have permission to perform this action.',
            });
        }
        return next();
    };
}

module.exports = { authMiddleware, authorizeRoles };