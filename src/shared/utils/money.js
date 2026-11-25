const Decimal = require('decimal.js');

function toDecimal(value, fieldName = 'number') {
    if (value === null || value === undefined || value === '') {
        return new Decimal(0);
    }
    if (value instanceof Decimal) {
        return value;
    }
    try {
        const d = new Decimal(value);
        if (!d.isFinite()) {
            const err = new Error(`Invalid finite ${fieldName}: ${value}`);
            err.statusCode = 400;
            throw err;
        }
        return d;
    } catch (e) {
        if (e.statusCode) throw e;
        const err = new Error(`Invalid ${fieldName}: ${value}`);
        err.statusCode = 400;
        throw err;
    }
}

function roundMoney(value, decimals = 2) {
    return toDecimal(value).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP).toNumber();
}

function addMoney(a, b, decimals = 2) {
    return toDecimal(a).plus(toDecimal(b)).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP).toNumber();
}

function subMoney(a, b, decimals = 2) {
    return toDecimal(a).minus(toDecimal(b)).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP).toNumber();
}

function mulMoney(a, b, decimals = 2) {
    return toDecimal(a).times(toDecimal(b)).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP).toNumber();
}

function divMoney(a, b, decimals = 6) {
    const denom = toDecimal(b);
    if (denom.isZero()) {
        return 0;
    }
    return toDecimal(a).div(denom).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP).toNumber();
}

module.exports = {
    Decimal,
    toDecimal,
    roundMoney,
    addMoney,
    subMoney,
    mulMoney,
    divMoney,
};