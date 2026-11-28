 const nodemailer = require('nodemailer');

    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.GMAIL_USER,
            pass: process.env.GMAIL_APP_PASSWORD,
        },
    });

    async function sendResetEmail(to, resetLink) {
        await transporter.sendMail({
            from: `"Inventory" <${process.env.GMAIL_USER}>`,
            to,
            subject: 'Reset your password',
            text: `Click the link to reset your password (valid for 15 minutes):\n${resetLink}`,
            html: `<p>Click the link to reset your password (valid for 15 minutes):</p><p><a href="${resetLink}">Reset password</a></p>`,
        });
    }

    module.exports = { sendResetEmail };