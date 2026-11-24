const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: [true, 'User name is required'],
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
    },
    { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);