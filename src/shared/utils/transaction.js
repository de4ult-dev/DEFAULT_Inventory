const mongoose = require('mongoose');

async function runInTransaction(fn, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction({
        readConcern: { level: 'local' },
        writeConcern: { w: 'majority' },
      });

      const result = await fn(session);
      await session.commitTransaction();
      return result;
    } catch (err) {
      if (session.inTransaction()) {
        await session.abortTransaction().catch(() => { });
      }

      const isTransient =
        err?.errorLabels?.includes('TransientTransactionError') ||
        err?.code === 117;

      if (isTransient && attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 50 * attempt));
        continue;
      }
      throw err;
    } finally {
      await session.endSession();
    }
  }
}

module.exports = { runInTransaction };