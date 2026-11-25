const express = require('express');
const router = express.Router();
const { signup, login, me } = require('./auth.controller');
const { authMiddleware } = require('../../shared/middlewares/auth.middleware');

router.post('/signup', signup);
router.post('/login', login);
router.get('/me', authMiddleware, me);

module.exports = router;