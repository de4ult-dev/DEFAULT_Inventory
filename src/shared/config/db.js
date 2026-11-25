const mongoose = require('mongoose');

let listenersAttached = false;

function attachConnectionListeners() {
    if (listenersAttached) return;
    listenersAttached = true;

    mongoose.connection.on('error', (err) => {
        console.error('MongoDB connection error:', err.message);
    });

    mongoose.connection.on('disconnected', () => {
        console.warn('MongoDB disconnected.');
    });

    mongoose.connection.on('reconnected', () => {
        console.log('MongoDB reconnected.');
    });
}

async function connectDB(mongoUri, options = {}) {
    if (!mongoUri) {
        throw new Error('MONGO_URI is not defined');
    }

    mongoose.set('strictQuery', true);
    attachConnectionListeners();

    await mongoose.connect(mongoUri, options);
    console.log('MongoDB connected with replica set support');

    return mongoose.connection;
}

async function disconnectDB() {
    if (mongoose.connection.readyState !== 0) {
        await mongoose.connection.close();
        console.log('MongoDB connection closed.');
    }
}

module.exports = { connectDB, disconnectDB };