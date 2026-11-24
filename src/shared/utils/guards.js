const { toDecimal } = require('./money');

const ALLOWED_CURRENCIES = ['USD', 'Kz'];

function assertValidCurrency(currency, fieldName = 'currency') {
  if (!ALLOWED_CURRENCIES.includes(currency)) {
    const err = new Error(`Invalid ${fieldName}: ${currency}. Allowed currencies are USD and Kz.`);
    err.statusCode = 400;
    throw err;
  }
}

function assertSameCurrency(leftCurrency, rightCurrency, context = 'operation') {
  assertValidCurrency(leftCurrency, 'source currency');
  assertValidCurrency(rightCurrency, 'target currency');

  if (leftCurrency !== rightCurrency) {
    const err = new Error(
      `Currency mismatch in ${context}: cannot mix ${leftCurrency} and ${rightCurrency} without explicit handling.`
    );
    err.statusCode = 400;
    throw err;
  }
}

function assertNonNegative(value, label = 'Value') {
  if (toDecimal(value).lt(0)) {
    const err = new Error(`${label} cannot be negative.`);
    err.statusCode = 400;
    throw err;
  }
}

function assertSufficientStock(currentQty, requestedQty, sku = '', bucket = 'AVAILABLE') {
  const avail = toDecimal(currentQty);
  const req = toDecimal(requestedQty);

  if (req.lte(0)) {
    const err = new Error(`Quantity must be greater than zero for ${sku || 'item'}.`);
    err.statusCode = 400;
    throw err;
  }

  if (avail.lt(req)) {
    const err = new Error(
      `Insufficient ${bucket.toLowerCase()} stock for ${sku || 'product'}: available ${avail.toString()}, requested ${req.toString()}.`
    );
    err.statusCode = 400;
    throw err;
  }
}

function assertSufficientCash(currentBalance, requestedAmount, cashboxName = 'Cashbox', currency = '') {
  const bal = toDecimal(currentBalance);
  const amt = toDecimal(requestedAmount);

  if (amt.lte(0)) {
    const err = new Error(`Amount must be greater than zero for ${cashboxName}.`);
    err.statusCode = 400;
    throw err;
  }

  if (bal.lt(amt)) {
    const suffix = currency ? ` (${currency})` : '';
    const err = new Error(
      `Insufficient balance in ${cashboxName}${suffix}: available ${bal.toString()}, requested ${amt.toString()}.`
    );
    err.statusCode = 400;
    throw err;
  }
}

module.exports = {
  ALLOWED_CURRENCIES,
  assertValidCurrency,
  assertSameCurrency,
  assertNonNegative,
  assertSufficientStock,
  assertSufficientCash,
};