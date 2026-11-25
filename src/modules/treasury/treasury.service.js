const Cashbox = require('./cashbox');
const CashMove = require('./cashMove');
const { runInTransaction } = require('../../shared/utils/transaction');
const { addMoney, subMoney, toDecimal } = require('../../shared/utils/money');
const {
  assertValidCurrency,
  assertSameCurrency,
  assertSufficientCash,
} = require('../../shared/utils/guards');
const { getNextSequence } = require('../../shared/services/sequence.service');
const { logAudit } = require('../../shared/services/audit.service');

/**
 * Records a single cash movement (IN or OUT) on a cashbox.
 * Can run inside an existing `session` (called by other services like Invoices/Expenses/Returns)
 * or open its own transaction when called standalone.
 */
async function recordCashMovement(
  {
    cashboxId,
    direction,
    amount,
    currency,
    category,
    referenceType,
    referenceId = null,
    referenceNumber = '',
    description = '',
    reason = '',
    performedBy = null,
    date = new Date(),
  },
  externalSession = null
) {
  if (!['IN', 'OUT'].includes(direction)) {
    const err = new Error(`Invalid cash movement direction: ${direction}`);
    err.statusCode = 400;
    throw err;
  }

  assertValidCurrency(currency, 'movement currency');

  const amtDec = toDecimal(amount);
  if (amtDec.lte(0)) {
    const err = new Error('Cash movement amount must be greater than zero.');
    err.statusCode = 400;
    throw err;
  }

  const cleanAmount = amtDec.toDecimalPlaces(2).toNumber();

  const execute = async (session) => {
    const cashbox = await Cashbox.findById(cashboxId).session(session);
    if (!cashbox) {
      const err = new Error('Cashbox not found.');
      err.statusCode = 404;
      throw err;
    }

    if (!cashbox.isActive) {
      const err = new Error(`Cashbox "${cashbox.name}" is inactive.`);
      err.statusCode = 400;
      throw err;
    }

    assertSameCurrency(cashbox.currency, currency, 'cash movement');

    const balanceBefore = toDecimal(cashbox.balance).toDecimalPlaces(2).toNumber();
    let balanceAfter;

    if (direction === 'OUT') {
      assertSufficientCash(balanceBefore, cleanAmount, cashbox.name, cashbox.currency);
      balanceAfter = subMoney(balanceBefore, cleanAmount, 2);
    } else {
      balanceAfter = addMoney(balanceBefore, cleanAmount, 2);
    }

    cashbox.balance = balanceAfter;
    await cashbox.save({ session });

    const [cashMove] = await CashMove.create(
      [
        {
          cashboxId: cashbox._id,
          direction,
          amount: cleanAmount,
          currency: cashbox.currency,
          balanceBefore,
          balanceAfter,
          category,
          referenceType,
          referenceId,
          referenceNumber,
          description,
          performedBy,
          date,
        },
      ],
      { session }
    );

    await logAudit(
      {
        entityType: 'CashMove',
        entityId: cashMove._id,
        entityNumber: referenceNumber || String(cashMove._id),
        action: direction === 'IN' ? 'CREATE' : 'POST',
        reason: reason || description || `${direction} ${category}`,
        before: { cashboxId: cashbox._id, balance: balanceBefore },
        after: { cashboxId: cashbox._id, balance: balanceAfter, cashMoveId: cashMove._id },
        performedBy,
        timestamp: date,
      },
      session
    );

    return { cashbox, cashMove };
  };

  if (externalSession) {
    return execute(externalSession);
  }

  return runInTransaction(execute);
}

/**
 * Transfers funds between two cashboxes of the SAME currency (no auto-conversion).
 */
async function transferBetweenCashboxes({
  fromCashboxId,
  toCashboxId,
  amount,
  description = '',
  reason = '',
  performedBy = null,
  date = new Date(),
}) {
  if (!fromCashboxId || !toCashboxId) {
    const err = new Error('Both source and destination cashboxes are required.');
    err.statusCode = 400;
    throw err;
  }

  if (String(fromCashboxId) === String(toCashboxId)) {
    const err = new Error('Source and destination cashboxes must be different.');
    err.statusCode = 400;
    throw err;
  }

  const amtDec = toDecimal(amount);
  if (amtDec.lte(0)) {
    const err = new Error('Transfer amount must be greater than zero.');
    err.statusCode = 400;
    throw err;
  }

  const cleanAmount = amtDec.toDecimalPlaces(2).toNumber();

  return runInTransaction(async (session) => {
    const fromBox = await Cashbox.findById(fromCashboxId).session(session);
    const toBox = await Cashbox.findById(toCashboxId).session(session);

    if (!fromBox) {
      const err = new Error('Source cashbox not found.');
      err.statusCode = 404;
      throw err;
    }
    if (!toBox) {
      const err = new Error('Destination cashbox not found.');
      err.statusCode = 404;
      throw err;
    }
    if (!fromBox.isActive || !toBox.isActive) {
      const err = new Error('Both cashboxes must be active for a transfer.');
      err.statusCode = 400;
      throw err;
    }

    assertSameCurrency(fromBox.currency, toBox.currency, 'cashbox transfer');
    assertSufficientCash(fromBox.balance, cleanAmount, fromBox.name, fromBox.currency);

    const transferNumber = await getNextSequence('CASH_TRANSFER', 'TRF', session);

    const outResult = await recordCashMovement(
      {
        cashboxId: fromBox._id,
        direction: 'OUT',
        amount: cleanAmount,
        currency: fromBox.currency,
        category: 'CASHBOX_TRANSFER',
        referenceType: 'TRANSFER',
        referenceId: toBox._id,
        referenceNumber: transferNumber,
        description: description || `Transfer to ${toBox.name}`,
        reason: reason || `Transfer ${transferNumber}`,
        performedBy,
        date,
      },
      session
    );

    const inResult = await recordCashMovement(
      {
        cashboxId: toBox._id,
        direction: 'IN',
        amount: cleanAmount,
        currency: toBox.currency,
        category: 'CASHBOX_TRANSFER',
        referenceType: 'TRANSFER',
        referenceId: fromBox._id,
        referenceNumber: transferNumber,
        description: description || `Transfer from ${fromBox.name}`,
        reason: reason || `Transfer ${transferNumber}`,
        performedBy,
        date,
      },
      session
    );

    await logAudit(
      {
        entityType: 'CashboxTransfer',
        entityId: null,
        entityNumber: transferNumber,
        action: 'TRANSFER',
        reason: reason || description || `Transfer from ${fromBox.name} to ${toBox.name}`,
        before: {
          fromCashboxId: fromBox._id,
          fromBalance: outResult.cashMove.balanceBefore,
          toCashboxId: toBox._id,
          toBalance: inResult.cashMove.balanceBefore,
        },
        after: {
          fromCashboxId: fromBox._id,
          fromBalance: outResult.cashMove.balanceAfter,
          toCashboxId: toBox._id,
          toBalance: inResult.cashMove.balanceAfter,
        },
        performedBy,
        timestamp: date,
      },
      session
    );

    return {
      transferNumber,
      currency: fromBox.currency,
      amount: cleanAmount,
      from: outResult,
      to: inResult,
    };
  });
}

/**
 * Reverses a cash movement (`CashMove`) by recording the opposite movement (`IN` <-> `OUT`)
 * inside a transaction and logging an audit entry.
 */
async function reverseCashMovement({
  cashMoveId,
  reason = '',
  performedBy = null,
  date = new Date(),
}) {
  if (!cashMoveId) {
    const err = new Error('cashMoveId is required.');
    err.statusCode = 400;
    throw err;
  }

  return runInTransaction(async (session) => {
    const originalMove = await CashMove.findById(cashMoveId).session(session);
    if (!originalMove) {
      const err = new Error('Cash movement not found.');
      err.statusCode = 404;
      throw err;
    }

    const oppositeDirection = originalMove.direction === 'IN' ? 'OUT' : 'IN';
    const reversalReason =
      reason || `Reversal of ${originalMove.direction} movement (${originalMove._id})`;

    const res = await recordCashMovement(
      {
        cashboxId: originalMove.cashboxId,
        direction: oppositeDirection,
        amount: originalMove.amount,
        currency: originalMove.currency,
        category: 'REVERSAL',
        referenceType: originalMove.referenceType || 'CASH_MOVE',
        referenceId: originalMove._id,
        referenceNumber: originalMove.referenceNumber || String(originalMove._id),
        description: reversalReason,
        reason: reversalReason,
        performedBy,
        date,
      },
      session
    );

    await logAudit(
      {
        entityType: 'CashMove',
        entityId: originalMove._id,
        entityNumber: originalMove.referenceNumber || String(originalMove._id),
        action: 'REVERSE',
        reason: reversalReason,
        before: {
          originalMoveId: originalMove._id,
          direction: originalMove.direction,
          amount: originalMove.amount,
          currency: originalMove.currency,
        },
        after: {
          reversalMoveId: res.cashMove._id,
          direction: oppositeDirection,
          newCashboxBalance: res.cashbox.balance,
        },
        performedBy,
        timestamp: date,
      },
      session
    );

    return {
      originalMove,
      reversalMove: res.cashMove,
      cashbox: res.cashbox,
    };
  });
}

/**
 * Fetches cashbox balance summary and chronological movements (`CashMove`) with optional date filters.
 */
async function getCashboxLedger(cashboxId, { from = null, to = null, limit = 200 } = {}) {
  const cashbox = await Cashbox.findById(cashboxId).lean();
  if (!cashbox) {
    const err = new Error('Cashbox not found.');
    err.statusCode = 404;
    throw err;
  }

  const query = { cashboxId: cashbox._id };
  if (from || to) {
    query.date = {};
    if (from) query.date.$gte = new Date(from);
    if (to) query.date.$lte = new Date(to);
  }

  const moves = await CashMove.find(query)
    .sort({ date: -1, createdAt: -1 })
    .limit(Number(limit) || 200)
    .lean();

  return {
    cashbox,
    currentBalance: cashbox.balance,
    currency: cashbox.currency,
    moves,
  };
}

module.exports = {
  recordCashMovement,
  transferBetweenCashboxes,
  reverseCashMovement,
  getCashboxLedger,
};