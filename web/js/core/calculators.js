// =============================================================================
// calculators.js — the two public-site calculators (migration 021 batch; no
// schema). Pure, unit-tested; landing.js renders them.
//
//   deliveryFeeEstimate(sector, subtotal)  — mirrors the rule in place_order:
//       below the sector's minimum order value the sector's delivery fee applies
//       (0 fee below the minimum = the order cannot be placed).
//   creditCostEstimate(monthlySpend, creditDays, annualRatePct) — what buying on
//       credit is worth to a kitchen: the cash it keeps in hand on average and
//       the finance cost that cash would otherwise carry at the given rate.
// =============================================================================

export function deliveryFeeEstimate(sector, subtotal) {
  const mov = Number(sector?.min_order_value) || 0;
  const feeBelow = Number(sector?.delivery_fee_below_mov) || 0;
  const value = Math.max(0, Number(subtotal) || 0);
  const shortfall = value < mov ? mov - value : 0;
  const fee = shortfall > 0 ? feeBelow : 0;
  return { mov, shortfall, fee, canOrder: shortfall === 0 || feeBelow > 0, total: value + fee };
}

export function creditCostEstimate(monthlySpend, creditDays, annualRatePct = 18) {
  const spend = Math.max(0, Number(monthlySpend) || 0);
  const days = Math.max(0, Number(creditDays) || 0);
  const rate = Math.max(0, Number(annualRatePct) || 0) / 100;
  const dailySpend = spend / 30;
  const cashInHand = dailySpend * days;                 // average outstanding you hold instead of paying at the door
  const yearlyValue = cashInHand * rate;                // what that float would cost at the rate (or earn)
  return { cashInHand: Math.round(cashInHand), yearlyValue: Math.round(yearlyValue), monthlyValue: Math.round(yearlyValue / 12) };
}
