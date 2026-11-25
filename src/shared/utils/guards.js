const { toDecimal } = require('./money');

const ALLOWED_CURRENCIES = ['USD', 'Kz'];

function normalizeCurrency(currency) {
  if (currency === null || currency === undefined) return currency;
  const trimmed = String(currency).trim();
  if (trimmed.toUpperCase() === 'USD') return 'USD';
  if (trimmed.toUpperCase() === 'KZ') return 'Kz';
  return trimmed;
}

function assertValidCurrency(currency, fieldName = 'currency') {
  const normalized = normalizeCurrency(currency);
  if (!ALLOWED_CURRENCIES.includes(normalized)) {
    const err = new Error(
      `Invalid ${fieldName}: ${currency}. Allowed currencies are USD and Kz.`
    );
    err.statusCode = 400;
    throw err;
  }
  return normalized;
}

function assertSameCurrency(leftCurrency, rightCurrency, context = 'operation') {
  const left = assertValidCurrency(leftCurrency, 'source currency');
  const right = assertValidCurrency(rightCurrency, 'target currency');

  if (left !== right) {
    const err = new Error(
      `Currency mismatch in ${context}: cannot mix ${left} and ${right} without explicit handling.`
    );
    err.statusCode = 400;
    throw err;
  }
}

function assertPositive(value, label = 'Amount') {
  if (!toDecimal(value).gt(0)) {
    const err = new Error(`${label} must be greater than zero.`);
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
  normalizeCurrency,
  assertValidCurrency,
  assertSameCurrency,
  assertPositive,
  assertNonNegative,
  assertSufficientStock,
  assertSufficientCash,
};