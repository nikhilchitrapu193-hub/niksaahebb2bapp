// =============================================================================
// calculators.js — pure front-end calculation helpers.
//
// No Supabase calls here. These are client-side estimates for displaying
// advisory numbers to the user. Actual billing goes through the database.
// =============================================================================

/**
 * Estimate delivery fee based on distance and weight.
 * This is an advisory display — actual fee is set in company_settings.
 *
 * @param {number} distanceKm
 * @param {number} weightKg
 * @returns {number} estimated fee in INR
 */
export function deliveryFeeEstimate(distanceKm, weightKg) {
  const BASE = 40;         // minimum fee
  const PER_KM = 5;        // per km beyond 5 km
  const PER_KG = 2;        // per kg beyond 20 kg
  const FREE_RADIUS = 5;   // km before distance charges kick in
  const FREE_WEIGHT = 20;  // kg before weight charges kick in

  const distCharge = Math.max(0, distanceKm - FREE_RADIUS) * PER_KM;
  const weightCharge = Math.max(0, weightKg - FREE_WEIGHT) * PER_KG;
  return Math.round(BASE + distCharge + weightCharge);
}

/**
 * Estimate credit/finance cost for an outstanding balance.
 * For advisory display on the customer payments screen.
 *
 * @param {number} outstandingINR   total overdue amount
 * @param {number} daysOverdue      days past the credit period
 * @returns {number} estimated penalty in INR (rounded to 2dp)
 */
export function creditCostEstimate(outstandingINR, daysOverdue) {
  if (outstandingINR <= 0 || daysOverdue <= 0) return 0;
  // 18% per annum simple interest
  const ANNUAL_RATE = 0.18;
  const daily = ANNUAL_RATE / 365;
  return Math.round(outstandingINR * daily * daysOverdue * 100) / 100;
}

/**
 * Convert a cart subtotal and coupon to a discount amount.
 * Mirrors the DB function coupon_check for instant UI feedback.
 *
 * @param {{ kind: 'percent'|'amount', value: number, min_order: number, max_discount: number|null }} coupon
 * @param {number} subtotal
 * @returns {{ discount: number, valid: boolean, message: string }}
 */
export function applyCouponLocally(coupon, subtotal) {
  if (!coupon) return { discount: 0, valid: false, message: '' };
  if (subtotal < (coupon.min_order || 0)) {
    return { discount: 0, valid: false, message: `Minimum order ₹${coupon.min_order} required` };
  }
  let discount = 0;
  if (coupon.kind === 'percent') {
    discount = subtotal * (coupon.value / 100);
    if (coupon.max_discount) discount = Math.min(discount, coupon.max_discount);
  } else {
    discount = coupon.value;
  }
  discount = Math.round(Math.min(discount, subtotal) * 100) / 100;
  return { discount, valid: true, message: `Coupon applied: ₹${discount.toFixed(2)} off` };
}

/**
 * FIFO allocation preview: distribute a payment across open invoices oldest-first.
 * Mirrors allocate_customer_credits() in the database.
 *
 * @param {Array<{ id: string, amount: number, paid: number }>} openOrders  sorted oldest-first
 * @param {number} payment  amount being applied
 * @returns {Array<{ order_id: string, amount: number }>}
 */
export function fifoAllocate(openOrders, payment) {
  let remaining = payment;
  const allocations = [];
  for (const o of openOrders) {
    if (remaining <= 0) break;
    const owed = o.amount - (o.paid || 0);
    if (owed <= 0) continue;
    const apply = Math.min(remaining, owed);
    allocations.push({ order_id: o.id, amount: apply });
    remaining -= apply;
  }
  return allocations;
}

/**
 * Suggested buying quantity: reorder to cover `coverDays` days at the moving
 * average daily consumption, minus current stock.
 * Mirrors suggestedBuy() in web/js/core/procurement.js.
 *
 * @param {{ stock_qty: number, avg_daily_qty: number }} product
 * @param {number} coverDays
 * @returns {number}  units to order (0 if stock already sufficient)
 */
export function suggestedBuy(product, coverDays = 7) {
  const target = Math.ceil((product.avg_daily_qty || 0) * coverDays);
  return Math.max(0, target - (product.stock_qty || 0));
}
