const Counter = require('../models/counter');

async function getNextSequence(key, prefix, session = null) {
    const options = {
        returnDocument: 'after',
        upsert: true,
    };
    if (session) {
        options.session = session;
    }

    const counter = await Counter.findOneAndUpdate(
        { key },
        { $inc: { seq: 1 } },
        options
    );

    const padded = String(counter.seq).padStart(6, '0');
    return prefix ? `${prefix}-${padded}` : padded;
}

module.exports = { getNextSequence };