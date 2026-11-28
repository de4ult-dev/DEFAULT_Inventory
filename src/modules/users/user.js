const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
    {
        fullName: {
            type: String,
            required: [true, 'Full name is required'],
            trim: true,
        },
        email: {
            type: String,
            required: [true, 'Email is required'],
            unique: true,
            trim: true,
            lowercase: true,
        },
        companyName: {
            type: String,
            required: [true, 'Company name is required'],
            trim: true,
        },
        username: {
            type: String,
            required: [true, 'Username is required'],
            unique: true,
            trim: true,
            lowercase: true,
        },
        passwordHash: {
            type: String,
            required: [true, 'Password hash is required'],
            select: false,
        },
        role: {
            type: String,
            enum: ['SUPER_ADMIN', 'MANAGER', 'ACCOUNTANT', 'SALES', 'WAREHOUSE', 'VIEWER'],
            required: true,
            default: 'SALES',
        },
        permissions: {
            type: [String],
            default: [],
        },
        isActive: {
            type: Boolean,
            default: true,
        },
        lastLoginAt: {
            type: Date,
            default: null,
        },
          resetPasswordTokenHash: {
        type: String,
        default: null,
        select: false,
    },
    resetPasswordExpiresAt: {
        type: Date,
        default: null,
        select: false,
    },
    },
    { timestamps: true }
);

// للحفاظ على التوافق مع أي كود قديم بيقرأ user.name
userSchema.virtual('name').get(function () {
    return this.fullName;
});

userSchema.index({ role: 1, isActive: 1 });
userSchema.index({ isActive: 1 });
userSchema.index({ lastLoginAt: 1 });

module.exports = mongoose.model('User', userSchema);