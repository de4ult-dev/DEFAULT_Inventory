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

    const balanceBefore = cashbox.balance;
    let balanceAfter;

    if (direction === 'OUT') {
      assertSufficientCash(balanceBefore, amount, cashbox.name, cashbox.currency);
      balanceAfter = subMoney(balanceBefore, amount, 2);
    } else {
      balanceAfter = addMoney(balanceBefore, amount, 2);
    }

    cashbox.balance = balanceAfter;
    await cashbox.save({ session });

    const [cashMove] = await CashMove.create(
      [
        {
          cashboxId: cashbox._id,
          direction,
          amount: amtDec.toDecimalPlaces(2).toNumber(),
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
    assertSufficientCash(fromBox.balance, amount, fromBox.name, fromBox.currency);

    const transferNumber = await getNextSequence('CASH_TRANSFER', 'TRF', session);

    const outResult = await recordCashMovement(
      {
        cashboxId: fromBox._id,
        direction: 'OUT',
        amount,
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
        amount,
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
      amount: amtDec.toDecimalPlaces(2).toNumber(),
      from: outResult,
      to: inResult,
    };
  });
}

module.exports = {
  recordCashMovement,
  transferBetweenCashboxes,
};