const mongoose = require('mongoose');

async function connectDB(mongoUri) {
    if (!mongoUri) {
        throw new Error('MONGO_URI is not defined');
    }

    mongoose.set('strictQuery', true);

    await mongoose.connect(mongoUri);
    console.log('MongoDB connected with replica set support');
    return mongoose.connection;
}

module.exports = { connectDB };