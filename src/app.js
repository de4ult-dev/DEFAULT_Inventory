const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');

// 1. استورد ملف راوتات الـ auth (عدّل المسار حسب مكان الملف عندك، مثلاً ./routes/auth.routes)
const authRoutes = require('./modules/auth/auth.routes');

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev'));
}

app.get('/health', (req, res) => {
  res.status(200).json({ success: true, message: 'DEFAULT API is running' });
});

// 2. ركّب الراوت على /api/auth قبل الـ 404 handler
app.use('/api/auth', authRoutes);

app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

app.use((err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    success: false,
    message: err.message || 'Internal server error',
  });
});

module.exports = app;