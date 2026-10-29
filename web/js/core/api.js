// =============================================================================
// api.js — every call the app makes to the backend, in one place.
//
// Pages never talk to Supabase directly; they call these named functions.
// That keeps the data layer easy to find, test and change (see docs/api.md).
//
// Reads use table queries (protected by Row Level Security).
// Writes to orders / users go through database functions (supabase.rpc),
// which re-check the caller's role. See supabase/migrations/.
// =============================================================================

import { supabase } from './supabase.js';
import { config, webRoot } from './config.js';

/** Unwrap a Supabase response: return data, or throw a readable Error. */
function unwrap({ data, error }) {
  if (error) throw new Error(friendlyMessage(error));
  return data;
}

/** Map low-level database errors to messages a person can act on. */
function friendlyMessage(error) {
  if (error.code === '23505') return 'That value already exists. Please use a different one.';
  if (error.code === '23503') return 'This item is still in use by other records.';
  if (error.code === '42501') return 'You do not have permission to do that.';
  return error.message;
}

// ---------- Supabase client access (for pages that need raw queries) ---------

/** Returns the shared Supabase client. Use sparingly — prefer named API functions. */
export function getSupabase() { return supabase; }

// ---------- Landing page / public --------------------------------------------

/**
 * Check whether Fresh Supply delivers to a pincode.
 * Returns { serviceable: boolean, city_id, sector_code } or null.
 */
export async function checkPincode(pincode) {
  const { data } = await supabase.rpc('check_pincode', { p_pincode: String(pincode) });
  return data ?? null;
}

/**
 * Claim the very first admin account (onboarding only).
 * Calls the Postgres function directly via RPC — it has a built-in guard
 * that returns false once any admin already exists, so it cannot be abused.
 * Returns true on success; throws if not authenticated or already claimed.
 */
export async function claimFirstAdmin() {
  return unwrap(await supabase.rpc('claim_first_admin'));
}

/**
 * Fetch the company settings row (for invoice / statement footers).
 * Returns null when not yet configured.
 */
export async function getCompanySettings() {
  return unwrap(await supabase.from('company_settings').select('*').maybeSingle());
}

// ---------- Catalogue --------------------------------------------------------

export async function listCategories() {
  return unwrap(await supabase.from('categories').select('*').order('sort_order').order('name'));
}

export async function saveCategory(cat) {
  const vals = { name: cat.name, sort_order: Number(cat.sort_order) || 0, parent_id: cat.parent_id || null };
  if (cat.id) return unwrap(await supabase.from('categories').update(vals).eq('id', cat.id).select().single());
  return unwrap(await supabase.from('categories').insert(vals).select().single());
}

export async function deleteCategory(id) {
  unwrap(await supabase.from('categories').delete().eq('id', id));
}

export async function listHsnCodes() {
  return unwrap(await supabase.from('hsn_codes').select('*').order('code'));
}

export async function saveProduct(p) {
  const vals = {
    name: p.name, sku: p.sku, category_id: p.category_id || null, unit: p.unit,
    price: Number(p.price) || 0, gst_rate: Number(p.gst_rate) || 0,
    stock_qty: p.stock_qty != null ? Number(p.stock_qty) : undefined,
    description: p.description || null,
    // hsn_code is the code string stored directly on products (e.g. '0702')
    hsn_code: p.hsn_code || null,
    pack_unit: p.pack_unit || null, pack_size: p.pack_size != null ? Number(p.pack_size) : null,
    parent_product_id: p.parent_product_id || null,
    variant_label: p.variant_label || null,
    veg_type: p.veg_type || null, grade: p.grade || null, origin: p.origin || null,
    brand: p.brand || null,
    shelf_life_days: p.shelf_life_days != null ? Number(p.shelf_life_days) : null,
    storage_note: p.storage_note || null,
    sold_by_weight: Boolean(p.sold_by_weight),
    weight_tolerance_pct: p.weight_tolerance_pct != null ? Number(p.weight_tolerance_pct) : null,
    in_stock: p.in_stock !== false,
    is_active: p.is_active !== false,
    market_price: p.market_price != null ? Number(p.market_price) : null,
    price_source: p.price_source || null,
    min_order_qty: p.min_order_qty != null ? Number(p.min_order_qty) : null,
    low_stock_threshold: p.low_stock_threshold != null ? Number(p.low_stock_threshold) : null,
  };
  // A board-priced product: never overwrite the price with the form value.
  if (p.price_source === 'rule') delete vals.price;
  if (p.id) return unwrap(await supabase.from('products').update(vals).eq('id', p.id).select().single());
  return unwrap(await supabase.from('products').insert(vals).select().single());
}

export async function setProductFlags(id, flags) {
  return unwrap(await supabase.from('products').update(flags).eq('id', id).select().single());
}

export async function uploadProductPhoto(productId, file) {
  const path = `products/${productId}/${Date.now()}_${file.name}`;
  const { error } = await supabase.storage.from('product-photos').upload(path, file, { upsert: true });
  if (error) throw error;
  unwrap(await supabase.from('products').update({ photo_path: path }).eq('id', productId));
  return path;
}

export async function upsertProducts(rows) {
  // Split into updates (rows with an id set by csv-import.js from the existing-product
  // lookup) and inserts (new products without an id). One DB call per row so each is
  // recorded as 'update' or 'insert' for tests and for audit clarity.
  const results = [];
  for (const row of rows) {
    if (row.id != null) {
      const { id, sku, ...fields } = row;
      const r = unwrap(await supabase.from('products').update({ sku, ...fields }).eq('id', id).select());
      if (Array.isArray(r)) results.push(...r); else if (r != null) results.push(r);
    } else {
      const r = unwrap(await supabase.from('products').insert(row).select());
      if (Array.isArray(r)) results.push(...r); else if (r != null) results.push(r);
    }
  }
  return results;
}

export async function listProductAvailability(productId) {
  return unwrap(await supabase.from('product_availability').select('*').eq('product_id', productId));
}

export async function setProductAvailability(productId, cityId, available) {
  if (available) {
    return unwrap(await supabase.from('product_availability').upsert({ product_id: productId, city_id: cityId, is_available: true }, { onConflict: 'product_id,city_id' }));
  }
  return unwrap(await supabase.from('product_availability').delete().eq('product_id', productId).eq('city_id', cityId));
}

/** Restaurants only see active products (enforced by RLS); admins see all. */
export async function listProducts() {
  return unwrap(await supabase.from('products').select('*, categories(name)').order('name'));
}

export function photoUrl(path) {
  if (!path) return null;
  return supabase.storage.from(config.photoBucket).getPublicUrl(path).data.publicUrl;
}

// ---------- Orders (restaurant + delivery + admin) ---------------------------

const ORDER_SELECT = '*, order_items(*), outlets(name)';   // outlets: migration 020

/** Filters are optional: { status, cityId, sectorCode }. RLS limits rows to the caller's scope. */
export async function listOrders({ status, cityId, sectorCode, approvalStatus } = {}) {
  let query = supabase.from('orders').select(ORDER_SELECT).order('created_at', { ascending: false }).limit(200);
  if (status) query = query.eq('status', status);
  if (approvalStatus) query = query.eq('approval_status', approvalStatus);
  if (cityId) query = query.eq('city_id', cityId);
  if (sectorCode) query = query.eq('sector_code', sectorCode);
  return unwrap(await query);
}

export async function getOrderHistory(orderId) {
  return unwrap(await supabase.from('order_status_history')
    .select('*').eq('order_id', orderId).order('changed_at', { ascending: false }));
}

/** place_order v9: accepts (items, opts) — items is the cart array, opts carries checkout fields. */
export async function placeOrder(items, { outletId = null, slot = 'morning', notes = null, deliveryDate = null, paymentMethod = 'cod', poReference = null, couponCode = null } = {}) {
  return unwrap(await supabase.rpc('place_order', {
    p_items: items,
    p_outlet_id: outletId || null,
    p_delivery_slot: slot,
    p_delivery_date: deliveryDate || null,
    p_note: notes || null,
    p_payment_method: paymentMethod,
    p_po_reference: poReference || null,
    p_coupon_code: couponCode || null,
  }));
}

export async function editOrder(orderId, items, { slot, note } = {}) {
  unwrap(await supabase.rpc('edit_order', {
    p_order_id: orderId,
    p_items: items ?? null,
    p_slot: slot ?? null,
    p_note: note ?? null,
  }));
}

export async function confirmOrder(orderId) {
  unwrap(await supabase.rpc('confirm_order', { p_order_id: orderId }));
}

export async function cancelOrder(orderId, reason) {
  unwrap(await supabase.rpc('cancel_order', { p_order_id: orderId, p_reason: reason || null }));
}

export async function setOrderStatus(orderId, status, note = null) {
  unwrap(await supabase.rpc('set_order_status', { p_order_id: orderId, p_new: status, p_note: note }));
}

export async function setPacked(orderId, items) {
  unwrap(await supabase.rpc('set_packed_quantities', { p_order_id: orderId, p_items: items }));
}

// ---------- Delivery ---------------------------------------------------------

export async function listDeliveryOrders({ cityId, sectorCode } = {}) {
  return listOrders({ status: 'out_for_delivery', cityId, sectorCode });
}

export async function recordDelivery(orderId, { podPhotoPath, latitude, longitude, recipientName, recipientPhone } = {}) {
  unwrap(await supabase.rpc('record_delivery', {
    p_order_id: orderId,
    p_pod_photo_path: podPhotoPath || null,
    p_latitude: latitude ?? null,
    p_longitude: longitude ?? null,
    p_recipient_name: recipientName || null,
    p_recipient_phone: recipientPhone || null,
  }));
}

/**
 * Complete a delivery with OTP verification.
 * p_otp: the 4-digit OTP the customer shows; p_returns: [] for a full delivery.
 */
export async function completeDelivery(orderId, { otp, returns = [], podPhotoPath, latitude, longitude } = {}) {
  unwrap(await supabase.rpc('complete_delivery', {
    p_order_id: orderId,
    p_otp: otp || null,
    p_returns: returns,
    p_pod_photo_path: podPhotoPath || null,
    p_latitude: latitude ?? null,
    p_longitude: longitude ?? null,
  }));
}

export async function uploadPodPhoto(orderId, file) {
  return uploadPOD(orderId, file);
}

export async function uploadPOD(orderId, file) {
  const ext = file.type === 'image/png' ? 'png' : 'jpg';
  const path = `${orderId}-${Date.now()}.${ext}`;
  unwrap(await supabase.storage.from(config.podBucket).upload(path, file, { contentType: file.type }));
  return path;
}

// ---------- Restaurants / customers (admin) ----------------------------------

export async function listRestaurants() {
  return unwrap(await supabase.from('restaurants').select('*').order('name'));
}

export async function getRestaurant(id) {
  return unwrap(await supabase.from('restaurants').select('*, cities(name)').eq('id', id).single());
}

export async function saveRestaurant(r) {
  const values = {
    name: r.name, owner_email: r.owner_email, owner_name: r.owner_name,
    phone: r.phone || null, address: r.address || null, city_id: r.city_id || null,
    sector_code: r.sector_code || null, gstin: r.gstin || null,
    credit_limit: Number(r.credit_limit) || 0,
    credit_days: Number(r.credit_days) || 0,
    payment_terms: r.payment_terms || null,
    is_active: Boolean(r.is_active ?? true),
    requires_approval: Boolean(r.requires_approval),
    approval_threshold: Number(r.approval_threshold) || 0,
    customer_type: r.customer_type || 'restaurant',
    warehouse_id: r.warehouse_id || null,
    notes: r.notes || null,
  };
  if (r.id) {
    return unwrap(await supabase.from('restaurants').update(values).eq('id', r.id).select().single());
  }
  return unwrap(await supabase.from('restaurants').insert(values).select().single());
}

export async function approveRestaurant(id, approve) {
  unwrap(await supabase.rpc('approve_restaurant', { p_restaurant_id: id, p_approve: approve }));
}

export async function setRestaurantStatus(id, status) {
  unwrap(await supabase.rpc('set_customer_status', { p_restaurant_id: id, p_status: status }));
}

export async function saveCustomerTerms(restaurantId, terms) {
  const num = (v) => (v === '' || v == null ? null : Number(v));
  const bool = (v) => (v === '' || v == null ? null : v === 'true' || v === true);
  unwrap(await supabase.from('restaurants').update({
    sector_code: terms.sector_code || null,
    city_id: terms.city_id || null,
    pincode: terms.pincode || null,
    warehouse_id: terms.warehouse_id || null,
    min_order_value: num(terms.min_order_value),
    delivery_fee_below_mov: num(terms.delivery_fee_below_mov),
    credit_days: num(terms.credit_days),
    credit_limit: num(terms.credit_limit),
    needs_order_approval: bool(terms.needs_order_approval),
  }).eq('id', restaurantId));
}

export async function listOutstandingBalances({ cityId } = {}) {
  let q = supabase.from('customer_balances').select('*').order('name');
  if (cityId) q = q.eq('city_id', cityId);
  return unwrap(await q);
}

// ---------- Cities / sectors / warehouses ------------------------------------

export async function listCities() {
  return unwrap(await supabase.from('cities').select('*, sectors(*)').order('name'));
}

export async function listSectors() {
  return unwrap(await supabase.from('sectors').select('*, cities(name)').order('name'));
}

export async function listWarehouses() {
  return unwrap(await supabase.from('warehouses').select('*').order('name'));
}

// ---------- Inventory / stock ------------------------------------------------

export async function listInventory({ warehouseId, categoryId } = {}) {
  let query = supabase.from('products').select('*, categories(name), stock_qty').order('name');
  if (warehouseId) query = query.eq('warehouse_id', warehouseId);
  if (categoryId) query = query.eq('category_id', categoryId);
  return unwrap(await query);
}

export async function getStockLedger(productId, { limit = 50 } = {}) {
  return unwrap(await supabase.from('stock_movements').select('*')
    .eq('product_id', productId).order('created_at', { ascending: false }).limit(limit));
}

export async function adjustStock({ productId, warehouseId, qty, reason }) {
  unwrap(await supabase.rpc('adjust_stock', {
    p_product_id: productId, p_warehouse_id: warehouseId,
    p_qty: qty, p_reason: reason,
  }));
}

// ---------- Procurement ------------------------------------------------------

export async function listPurchaseOrders({ warehouseId, status, limit = 100 } = {}) {
  let query = supabase.from('purchase_orders').select('*, suppliers(name), warehouses(name)').order('created_at', { ascending: false }).limit(limit);
  if (warehouseId) query = query.eq('warehouse_id', warehouseId);
  if (status) query = query.eq('status', status);
  return unwrap(await query);
}

export async function getPurchaseOrder(id) {
  return unwrap(await supabase.from('purchase_orders').select('*, purchase_order_items(*), suppliers(name), warehouses(name)').eq('id', id).single());
}

export async function savePurchaseOrder({ id, supplierId, warehouseId, items, expectedDate, note }) {
  return unwrap(await supabase.rpc('save_purchase_order', {
    p_id: id || null, p_supplier_id: supplierId, p_warehouse_id: warehouseId,
    p_items: items, p_expected_date: expectedDate || null, p_note: note || null,
  }));
}

export async function setPurchaseOrderStatus(id, status) {
  return unwrap(await supabase.rpc('set_purchase_order_status', { p_po_id: id, p_status: status }));
}

export async function receiveGoods({ purchaseOrderId, poId, warehouseId, supplierId, source, items,
    billPhotoPath, billPath, billAmount, billDate, supplierRef, paidCash, note }) {
  return unwrap(await supabase.rpc('receive_goods', {
    p_po_id: poId ?? purchaseOrderId ?? null,
    p_warehouse_id: warehouseId,
    p_supplier_id: supplierId || null,
    p_source: source || 'direct',
    p_items: items,
    p_bill_path: billPhotoPath ?? billPath ?? null,
    p_bill_amount: billAmount ? Number(billAmount) : null,
    p_paid_cash: paidCash ?? false,
    p_bill_date: billDate || null,
    p_supplier_ref: supplierRef || null,
    p_note: note || null,
  }));
}

// ---------- Suppliers (P2-4) -------------------------------------------------

export async function listSuppliers({ status } = {}) {
  let query = supabase.from('suppliers').select('*, cities(name)').order('name');
  if (status) query = query.eq('status', status);
  return unwrap(await query);
}

export async function getSupplier(id) {
  return unwrap(await supabase.from('suppliers').select('*').eq('id', id).single());
}

export async function saveSupplier(s) {
  return unwrap(await supabase.rpc('save_supplier', {
    p_id: s.id || null, p_name: s.name, p_contact_name: s.contact_name || null,
    p_phone: s.phone || null, p_email: s.email || null, p_address: s.address || null,
    p_city_id: s.city_id || null, p_gstin: s.gstin || null,
    p_status: s.status || 'pending', p_notes: s.notes || null,
    p_portal_email: s.portal_email || null,
  }));
}

export async function inviteSupplier(supplierId) {
  const { data, error } = await supabase.functions.invoke('invite-supplier', {
    body: { supplier_id: supplierId, redirect_to: `${webRoot}supplier/login.html` },
  });
  if (error) throw new Error(error.message);
  if (data?.error) throw new Error(data.error);
  return data;
}

export async function listSupplierProducts(supplierId) {
  let query = supabase.from('supplier_products').select('*, products(name, sku)').order('created_at');
  if (supplierId) query = query.eq('supplier_id', supplierId);
  return unwrap(await query);
}

export async function saveSupplierProduct({ id, supplier_id, product_id, price, moq, lead_days, valid_from, valid_to, is_preferred }) {
  const values = {
    supplier_id,
    product_id,
    price: Number(price),
    moq: Number(moq) || 1,
    lead_days: Number(lead_days) || 1,
    valid_from: valid_from || null,
    valid_to: valid_to || null,
    is_preferred: Boolean(is_preferred),
  };
  if (id) return unwrap(await supabase.from('supplier_products').update(values).eq('id', id).select().single());
  return unwrap(await supabase.from('supplier_products').upsert(values, { onConflict: 'supplier_id,product_id' }).select().single());
}

// ---------- Pricing / price lists (P2-3) -------------------------------------

export async function listPriceLists() {
  return unwrap(await supabase.from('price_lists').select('*, cities(name), sectors(name)').order('name'));
}

export async function savePriceList({ id, name, city_id, sector_code, adjustment_pct, is_active }) {
  const values = {
    name,
    city_id: city_id || null,
    sector_code: sector_code || null,
    adjustment_pct: Number(adjustment_pct) || 0,
    is_active: Boolean(is_active ?? true),
  };
  if (id) return unwrap(await supabase.from('price_lists').update(values).eq('id', id).select().single());
  return unwrap(await supabase.from('price_lists').insert(values).select().single());
}

export async function upsertPriceListItems(items) {
  return unwrap(await supabase.from('price_list_items').upsert(items, { onConflict: 'price_list_id,product_id' }).select());
}

export async function listPriceListItems(priceListId) {
  return unwrap(await supabase.from('price_list_items').select('*, products(name, sku)').eq('price_list_id', priceListId));
}

export async function savePriceListItem({ id, priceListId, productId, price, discountPct }) {
  return unwrap(await supabase.rpc('save_price_list_item', {
    p_id: id || null, p_price_list_id: priceListId, p_product_id: productId,
    p_price: price || null, p_discount_pct: discountPct || null,
  }));
}

export async function assignPriceList(restaurantId, priceListId) {
  unwrap(await supabase.rpc('assign_price_list', { p_restaurant_id: restaurantId, p_price_list_id: priceListId }));
}

// ---------- Price board (admin) -----------------------------------------------

export async function listPriceBoard(arg = {}) {
  // Called as listPriceBoard(categoryId) from price-board.js or listPriceBoard({ cityId, categoryId })
  const { cityId, categoryId } = (arg && typeof arg === 'object') ? arg : { categoryId: arg || null };
  return unwrap(await supabase.rpc('price_board', { p_city_id: cityId || null, p_category_id: categoryId || null }));
}

export async function publishPrices(productIds) {
  return unwrap(await supabase.rpc('apply_prices', { p_product_ids: productIds }));
}

// ---------- Fulfilment -------------------------------------------------------

export async function listFulfilmentOrders({ date, warehouseId, status } = {}) {
  let query = supabase.from('orders').select(ORDER_SELECT).order('delivery_slot').order('created_at');
  if (date) { query = query.gte('created_at', date + 'T00:00:00').lte('created_at', date + 'T23:59:59'); }
  if (warehouseId) query = query.eq('warehouse_id', warehouseId);
  if (status) query = query.eq('status', status);
  return unwrap(await query);
}

export async function assignTrip(orderId, driverId) {
  unwrap(await supabase.rpc('assign_trip', { p_order_id: orderId, p_driver_id: driverId }));
}

export async function listDrivers() {
  const users = unwrap(await supabase.rpc('admin_list_users', {}));
  return users.filter((u) => u.role === 'delivery');
}

// ---------- Order issues (restaurant + admin) --------------------------------

export async function reportIssue(orderId, kind, note) {
  return unwrap(await supabase.rpc('report_issue', { p_order_id: orderId, p_kind: kind, p_note: note || null }));
}

export async function resolveIssue(issueId, { resolution, creditAmount = 0, reject = false } = {}) {
  unwrap(await supabase.rpc('resolve_issue', { p_issue_id: issueId, p_resolution: resolution || null, p_credit_amount: Number(creditAmount) || 0, p_reject: reject }));
}

export async function listOrderIssues({ status, orderId, limit = 200 } = {}) {
  let query = supabase.from('order_issues').select('*, orders(order_number, status)').order('created_at', { ascending: false }).limit(limit);
  if (status) query = query.eq('status', status);
  if (orderId) query = query.eq('order_id', orderId);
  return unwrap(await query);
}

export async function listCreditNotes({ restaurantId, limit = 200 } = {}) {
  let query = supabase.from('credit_notes').select('*').order('created_at', { ascending: false }).limit(limit);
  if (restaurantId) query = query.eq('restaurant_id', restaurantId);
  return unwrap(await query);
}

// ---------- Slot config -------------------------------------------------------

export async function listSlotConfig() {
  return unwrap(await supabase.from('slot_config').select('*, cities(name), sectors(name)').order('city_id').order('delivery_slot'));
}

export async function saveSlotConfig(c) {
  const values = {
    city_id: c.city_id, delivery_slot: c.delivery_slot,
    cutoff_hour: c.cutoff_hour, cutoff_minute: c.cutoff_minute || 0,
    max_orders: c.max_orders || null,
    sector_code: c.sector_code || null,
  };
  if (c.id) {
    return unwrap(await supabase.from('slot_config').update(values).eq('id', c.id).select().single());
  }
  return unwrap(await supabase.from('slot_config').insert(values).select().single());
}

export async function deleteSlotConfig(id) {
  unwrap(await supabase.from('slot_config').delete().eq('id', id));
}

// ---------- Payments & receivables -------------------------------------------

export async function getReceivablesSummary() {
  return unwrap(await supabase.rpc('receivables_summary'));
}

export async function getCustomerReceivables(restaurantId) {
  return unwrap(await supabase.rpc('customer_receivables', { p_restaurant_id: restaurantId }));
}

export async function getCustomerStatement(restaurantId, from, to) {
  return unwrap(await supabase.rpc('customer_statement', { p_restaurant_id: restaurantId, p_from: from, p_to: to }));
}

export async function recordPayment(restaurantId, { amount, method, reference, receivedOn, note, allocations }) {
  return unwrap(await supabase.rpc('record_payment', {
    p_restaurant_id: restaurantId, p_amount: amount, p_method: method,
    p_reference: reference || null, p_received_on: receivedOn || null,
    p_note: note || null, p_allocations: (allocations && allocations.length > 0) ? allocations : null,
  }));
}

export async function allocatePayment(paymentId, allocations) {
  unwrap(await supabase.rpc('allocate_payment', { p_payment_id: paymentId, p_allocations: allocations }));
}

export async function voidPayment(paymentId, reason) {
  unwrap(await supabase.rpc('void_payment', { p_payment_id: paymentId, p_reason: reason || null }));
}

export async function raiseDebitNote(restaurantId, { amount, reason, orderId, dueDate }) {
  return unwrap(await supabase.rpc('raise_debit_note', {
    p_restaurant_id: restaurantId, p_amount: amount, p_reason: reason,
    p_order_id: orderId || null, p_due_date: dueDate || null,
  }));
}

export async function listPayments({ restaurantId, limit = 200 } = {}) {
  let query = supabase.from('payments').select('*').order('received_on', { ascending: false }).limit(limit);
  if (restaurantId) query = query.eq('restaurant_id', restaurantId);
  return unwrap(await query);
}

export async function listDebitNotes({ restaurantId, limit = 200 } = {}) {
  let query = supabase.from('debit_notes').select('*').order('created_at', { ascending: false }).limit(limit);
  if (restaurantId) query = query.eq('restaurant_id', restaurantId);
  return unwrap(await query);
}

export async function listPaymentAllocations({ paymentId, creditNoteId, orderId } = {}) {
  let query = supabase.from('payment_allocations').select('*, payments(amount, method), orders(order_number, total_amount)').limit(500);
  if (paymentId) query = query.eq('payment_id', paymentId);
  if (creditNoteId) query = query.eq('credit_note_id', creditNoteId);
  if (orderId) query = query.eq('order_id', orderId);
  return unwrap(await query);
}

/** Create a Razorpay order via Edge Function. Returns { order_id, amount, currency, key }. */
export async function createOnlinePaymentOrder(amount) {
  const { data, error } = await supabase.functions.invoke('razorpay-order', {
    body: { amount },
  });
  if (error) {
    let message = error.message;
    try { message = (await error.context?.json())?.error ?? message; } catch { /* keep default */ }
    throw new Error(message);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

// ---------- Notifications ----------------------------------------------------

export async function listNotificationSettings() {
  return unwrap(await supabase.from('notification_settings').select('*').order('event').order('channel'));
}

export async function saveNotificationSetting(row) {
  const values = {
    event: row.event,
    sector_code: row.sector_code ?? null,
    sms_enabled: Boolean(row.sms_enabled),
    email_enabled: Boolean(row.email_enabled),
    sms_template: row.sms_template ?? '',
    email_subject: row.email_subject ?? '',
    email_template: row.email_template ?? '',
  };
  if (row.id) return unwrap(await supabase.from('notification_settings').update(values).eq('id', row.id).select().single());
  return unwrap(await supabase.from('notification_settings').insert(values).select().single());
}

export async function deleteNotificationSetting(id) {
  unwrap(await supabase.from('notification_settings').delete().eq('id', id));
}

export async function listNotifications({ status, channel, restaurantId, orderId, limit = 200 } = {}) {
  let query = supabase.from('notifications').select('*, orders(order_number)').order('created_at', { ascending: false }).limit(limit);
  if (status) query = query.eq('status', status);
  if (channel) query = query.eq('channel', channel);
  if (restaurantId) query = query.eq('restaurant_id', restaurantId);
  if (orderId) query = query.eq('order_id', orderId);
  return unwrap(await query);
}

export async function retryNotification(id) {
  return unwrap(await supabase.rpc('retry_notification', { p_id: id }));
}

export async function sendNotificationsNow({ limit = 50, dryRun = false } = {}) {
  const { data, error } = await supabase.functions.invoke('send-notifications', {
    body: { limit, dry_run: dryRun },
  });
  if (error) {
    let message = error.message;
    try { message = (await error.context?.json())?.error ?? message; } catch { /* keep default */ }
    throw new Error(message);
  }
  return data;
}

// ---------- Support ----------------------------------------------------------

export async function getSupportChannels() {
  // support_channels() is a security-definer function (migration 20261027000001)
  // accessible to anon; it returns name, phone, whatsapp, email, address, fssai, gstin.
  return unwrap(await supabase.rpc('support_channels'));
}

export async function listTickets({ status, restaurantId, assignedTo, limit = 200 } = {}) {
  let query = supabase.from('support_tickets').select('*, restaurants(name, phone)').order('created_at', { ascending: false }).limit(limit);
  if (status) query = query.eq('status', status);
  if (restaurantId) query = query.eq('restaurant_id', restaurantId);
  if (assignedTo) query = query.eq('assigned_to', assignedTo);
  return unwrap(await query);
}

export async function listTicketMessages(ticketId) {
  return unwrap(await supabase.from('ticket_messages').select('*').eq('ticket_id', ticketId).order('created_at'));
}

export async function openTicket({ subject, body, orderId, restaurantId, priority = 'normal' }) {
  return unwrap(await supabase.rpc('open_ticket', { p_subject: subject, p_body: body, p_order_id: orderId || null, p_restaurant_id: restaurantId || null, p_priority: priority }));
}

export async function replyTicket(ticketId, body) {
  unwrap(await supabase.rpc('reply_ticket', { p_ticket_id: ticketId, p_body: body }));
}

export async function setTicket(ticketId, { status, assignedTo, priority } = {}) {
  unwrap(await supabase.rpc('set_ticket', { p_ticket_id: ticketId, p_status: status ?? null, p_assigned_to: assignedTo ?? null, p_priority: priority ?? null }));
}

// ---------- Help articles ----------------------------------------------------

export async function listHelpArticles(audience) {
  let query = supabase.from('help_articles').select('*').eq('is_published', true).order('sort_order').order('title');
  // 'customer' audience also sees 'public' articles; other audiences see only their own.
  if (audience === 'customer') query = query.in('audience', ['customer', 'public']);
  else if (audience) query = query.eq('audience', audience);
  return unwrap(await query);
}

export async function saveHelpArticle(a) {
  const values = { slug: a.slug, title: a.title, body: a.body, audience: a.audience, is_published: Boolean(a.is_published), sort_order: Number(a.sort_order) || 0 };
  if (a.id) return unwrap(await supabase.from('help_articles').update(values).eq('id', a.id).select().single());
  return unwrap(await supabase.from('help_articles').insert(values).select().single());
}

export async function deleteHelpArticle(id) {
  unwrap(await supabase.from('help_articles').delete().eq('id', id));
}

// ---------- Delivery GPS -----------------------------------------------------

export async function getDeliveryPins() {
  return unwrap(await supabase.rpc('delivery_pins'));
}

export async function updateMyLocation(lat, lng) {
  unwrap(await supabase.rpc('update_my_location', { p_lat: lat, p_lng: lng }));
}

// ---------- Reports ----------------------------------------------------------

/** sales_report(): rows { key, label, orders, quantity, subtotal, tax, delivery_fee, total, cancelled }. reports:view. */
export async function getSalesReport({ from, to, groupBy = 'day', cityId = null }) {
  return unwrap(await supabase.rpc('sales_report', { p_from: from, p_to: to, p_group_by: groupBy, p_city_id: cityId || null }));
}

/** receivables_trend(): one row per week { week_end, invoiced, collected, open, overdue }, oldest first. */
export async function getReceivablesTrend(weeks = 12, cityId = null) {
  return unwrap(await supabase.rpc('receivables_trend', { p_weeks: weeks, p_city_id: cityId || null }));
}

/** Finance summary: top-line numbers for the dashboard. */
export async function getFinanceSummary({ from, to, cityId = null } = {}) {
  return unwrap(await supabase.rpc('finance_summary', { p_from: from || null, p_to: to || null, p_city_id: cityId || null }));
}

/** Category mix report: revenue by category within a date range. */
export async function getCategoryMix({ from, to, cityId = null } = {}) {
  return unwrap(await supabase.rpc('category_mix_report', { p_from: from, p_to: to, p_city_id: cityId || null }));
}

/** Customer spend report (my_spend_report for restaurants). */
export async function getMySpendReport({ from, to } = {}) {
  return unwrap(await supabase.rpc('my_spend_report', { p_from: from || null, p_to: to || null }));
}

// ---------- Customer documents -----------------------------------------------

export async function uploadCustomerDocument(restaurantId, kind, file) {
  const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' }[file.type];
  if (!extension) throw new Error('Please choose a PDF, JPG, PNG or WebP file.');
  if (file.size > 8 * 1024 * 1024) throw new Error('File is larger than 8 MB.');
  const path = `${restaurantId}/${kind}-${Date.now()}.${extension}`;
  unwrap(await supabase.storage.from(config.documentBucket).upload(path, file, { contentType: file.type, upsert: true }));
  unwrap(await supabase.rpc('set_customer_document', { p_restaurant_id: restaurantId, p_kind: kind, p_path: path }));
  return path;
}

export async function customerDocumentUrl(path, seconds = 600) {
  if (!path) return null;
  return unwrap(await supabase.storage.from(config.documentBucket).createSignedUrl(path, seconds)).signedUrl;
}

// ---------- Content pages ----------------------------------------------------

export async function listContentPages() {
  return unwrap(await supabase.from('content_pages').select('*').order('sort_order').order('title'));
}

export async function getContentPage(slug) {
  return unwrap(await supabase.from('content_pages').select('*').eq('slug', slug).maybeSingle());
}

export async function saveContentPage(page) {
  const values = { slug: page.slug, title: page.title, body: page.body, is_published: Boolean(page.is_published),
    show_in_footer: Boolean(page.show_in_footer), sort_order: Number(page.sort_order) || 0, updated_at: new Date().toISOString() };
  return unwrap(await supabase.from('content_pages').upsert(values, { onConflict: 'slug' }).select().single());
}

export async function deleteContentPage(slug) {
  unwrap(await supabase.from('content_pages').delete().eq('slug', slug));
}

// ---------- Customer organisation (migration 020) ----------------------------

export async function listOutlets(restaurantId) {
  let query = supabase.from('outlets').select('*').order('is_primary', { ascending: false }).order('name');
  if (restaurantId) query = query.eq('restaurant_id', restaurantId);
  return unwrap(await query);
}

export async function saveOutlet({ id, restaurantId, name, address, phone, cityId, pincode, lat, lng, defaultSlot = 'morning', isActive = true, warehouseId }) {
  return unwrap(await supabase.rpc('save_outlet', {
    p_id: id || null, p_restaurant_id: restaurantId || null, p_name: name, p_address: address, p_phone: phone || null,
    p_city_id: cityId || null, p_pincode: pincode || null, p_lat: lat ?? null, p_lng: lng ?? null,
    p_default_slot: defaultSlot, p_is_active: isActive, p_warehouse_id: warehouseId || null,
  }));
}

export async function listMyCustomerUsers() {
  return unwrap(await supabase.rpc('my_customer_users'));
}

export async function listCustomerLogins() {
  return unwrap(await supabase.rpc('admin_customer_logins', {}));
}

/** Admin actions on a customer's authentication state (migration 016). */
export async function customerAccess(action, restaurantId, extra = {}) {
  const { data, error } = await supabase.functions.invoke('customer-access', {
    body: { action, restaurant_id: restaurantId, ...extra },
  });
  if (error) {
    let message = error.message;
    try { message = (await error.context?.json())?.error ?? message; } catch { /* keep default */ }
    throw new Error(message);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

export async function listCustomerUsersOf(restaurantId) {
  return unwrap(await supabase.rpc('customer_users_of', { p_restaurant_id: restaurantId }));
}

export async function setCustomerUser(userId, { role, outletId, isActive } = {}) {
  unwrap(await supabase.rpc('set_customer_user', { p_user_id: userId, p_role: role ?? null, p_outlet_id: outletId ?? null, p_is_active: isActive ?? null }));
}

export async function inviteCustomerUser({ restaurantId, email, fullName, phone, role, outletId }) {
  const { data, error } = await supabase.functions.invoke('customer-users', {
    body: { action: 'invite', restaurant_id: restaurantId, email, full_name: fullName, phone, role, outlet_id: outletId || null, redirect_to: `${webRoot}reset.html?role=restaurant` },
  });
  if (error) {
    let message = error.message;
    try { message = (await error.context?.json())?.error ?? message; } catch { /* keep default */ }
    throw new Error(message);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

export async function approveOrder(orderId, approve, note) {
  unwrap(await supabase.rpc('approve_order', { p_order_id: orderId, p_approve: approve, p_note: note || null }));
}

// ---------- P2-2 Ordering Plus: Coupons --------------------------------------

/** Validate a coupon code for the cart (returns { valid, discount_amount, message }). */
export async function validateCoupon(code, subtotal) {
  return unwrap(await supabase.rpc('coupon_check', { p_code: code, p_subtotal: subtotal }));
}

/** Admin: list all coupons. */
export async function listCoupons({ isActive } = {}) {
  let query = supabase.from('coupons').select('*').order('created_at', { ascending: false });
  if (isActive !== undefined) query = query.eq('is_active', isActive);
  return unwrap(await query);
}

/** Admin: create or update a coupon. */
export async function saveCoupon(c) {
  const values = {
    code: (c.code || '').toUpperCase().trim(),
    kind: c.kind, value: Number(c.value), min_order: Number(c.min_order) || 0,
    max_discount: c.max_discount ? Number(c.max_discount) : null,
    max_uses: c.max_uses ? Number(c.max_uses) : null,
    per_customer: Number(c.per_customer) || 1,
    valid_from: c.valid_from || null, valid_to: c.valid_to || null,
    is_active: Boolean(c.is_active ?? true), description: c.description || null,
  };
  if (c.id) return unwrap(await supabase.from('coupons').update(values).eq('id', c.id).select().single());
  return unwrap(await supabase.from('coupons').insert(values).select().single());
}

/** Admin: usage log for one coupon. */
export async function listCouponRedemptions(couponId, { limit = 200 } = {}) {
  return unwrap(await supabase.from('coupon_redemptions')
    .select('*, orders(order_number), restaurants(name)')
    .eq('coupon_id', couponId).order('created_at', { ascending: false }).limit(limit));
}

// ---------- P2-2 Ordering Plus: Standing orders ------------------------------

/** Restaurant: my standing orders; Admin: all. */
export async function listStandingOrders({ restaurantId, isActive } = {}) {
  let query = supabase.from('standing_orders').select('*, standing_order_items(*), restaurants(name), outlets(name)')
    .order('created_at', { ascending: false });
  if (restaurantId) query = query.eq('restaurant_id', restaurantId);
  if (isActive !== undefined) query = query.eq('is_active', isActive);
  return unwrap(await query);
}

/** Restaurant: save (upsert) a standing order. Returns the standing order id. */
export async function saveStandingOrder({ id, restaurantId, outletId, items, days, slot, label, startDate, endDate }) {
  return unwrap(await supabase.rpc('save_standing_order', {
    p_id: id || null, p_restaurant_id: restaurantId || null, p_outlet_id: outletId || null,
    p_items: items, p_days: days, p_slot: slot || 'morning',
    p_label: label || null, p_start_date: startDate || null, p_end_date: endDate || null,
  }));
}

/** Toggle a standing order on or off. */
export async function setStandingOrderActive(id, active) {
  unwrap(await supabase.rpc('set_standing_order_active', { p_id: id, p_active: Boolean(active) }));
}

// ---------- P2-2 Ordering Plus: Quotes ---------------------------------------

/** Admin: list all quotes; Restaurant: own quotes. */
export async function listQuotes({ status, restaurantId } = {}) {
  let query = supabase.from('quotes').select('*, quote_items(*), restaurants(name)')
    .order('created_at', { ascending: false }).limit(200);
  if (status) query = query.eq('status', status);
  if (restaurantId) query = query.eq('restaurant_id', restaurantId);
  return unwrap(await query);
}

/** Admin: create or update a draft quote. Returns quote id. */
export async function saveQuote({ id, restaurantId, outletId, items, validDays, note }) {
  return unwrap(await supabase.rpc('save_quote', {
    p_id: id || null, p_restaurant_id: restaurantId, p_outlet_id: outletId || null,
    p_items: items, p_valid_days: validDays || 3, p_note: note || null,
  }));
}

/** Admin: change quote status (draft → sent, sent → expired, etc.). */
export async function setQuoteStatus(id, status) {
  unwrap(await supabase.rpc('set_quote_status', { p_id: id, p_status: status }));
}

/** Restaurant: accept a quote (creates an order). Returns new order id. */
export async function acceptQuote(quoteId) {
  return unwrap(await supabase.rpc('accept_quote', { p_quote_id: quoteId }));
}

/** Restaurant: decline a quote. */
export async function declineQuote(quoteId, reason) {
  unwrap(await supabase.rpc('decline_quote', { p_quote_id: quoteId, p_reason: reason || null }));
}

// ---------- P2-8 Fleetbase trips ---------------------------------------------

/** List Fleetbase trips synced to this project. */
export async function listTrips({ status, driverId, date } = {}) {
  let query = supabase.from('fleetbase_trips').select('*, orders(order_number), profiles(full_name)').order('created_at', { ascending: false }).limit(200);
  if (status) query = query.eq('status', status);
  if (driverId) query = query.eq('driver_id', driverId);
  if (date) { query = query.gte('created_at', date + 'T00:00:00').lte('created_at', date + 'T23:59:59'); }
  return unwrap(await query);
}

/** Dispatch a Fleetbase trip for an order (calls Edge Function). */
export async function dispatchTrip(orderId) {
  const { data, error } = await supabase.functions.invoke('fleetbase-dispatch', {
    body: { order_id: orderId },
  });
  if (error) throw new Error(error.message);
  if (data?.error) throw new Error(data.error);
  return data;
}

/** Cancel a Fleetbase trip. */
export async function cancelTrip(tripId, reason) {
  unwrap(await supabase.rpc('cancel_fleetbase_trip', { p_trip_id: tripId, p_reason: reason || null }));
}

// =============================================================================
// PATCH 5 — all functions imported by Phase 2 page modules that were missing
// from this file. Added 2026-10-28.
// =============================================================================

// ---------- getOrder (single order by id) ------------------------------------

export async function getOrder(id) {
  return unwrap(await supabase.from('orders')
    .select(ORDER_SELECT).eq('id', id).single());
}

// ---------- Procurement: create / update PO (wrappers for savePurchaseOrder) -

/** Create a new purchase order via the create_purchase_order RPC. */
export async function createPurchaseOrder({ supplierId, warehouseId, items, expectedDate, note }) {
  return unwrap(await supabase.rpc('create_purchase_order', {
    p_supplier_id: supplierId, p_warehouse_id: warehouseId || null,
    p_items: items, p_expected_date: expectedDate || null, p_note: note || null,
  }));
}

/** Update an existing purchase order. Alias used by purchase-orders.js screen. */
export async function updatePurchaseOrder(id, { supplierId, warehouseId, items, expectedDate, note }) {
  return savePurchaseOrder({ id, supplierId, warehouseId, items, expectedDate, note });
}

/** Buying list: suggested quantities for next PO, keyed by supplier. */
export async function getBuyingList(warehouseId, date, coverDays) {
  return unwrap(await supabase.rpc('buying_list', {
    p_warehouse_id: warehouseId || null,
    p_date: date || null,
    p_cover_days: coverDays != null ? Number(coverDays) : 1,
  }));
}

// ---------- Supplier product removal -----------------------------------------

export async function deleteSupplierProduct(id) {
  unwrap(await supabase.from('supplier_products').delete().eq('id', id));
}

// ---------- Restaurant self-service ------------------------------------------

/** Current customer's order terms (credit limit, days, price list). */
export async function getMyOrderTerms() {
  return unwrap(await supabase.rpc('my_order_terms'));
}

/** Price list visible to the logged-in restaurant. */
export async function getMyPriceList() {
  return unwrap(await supabase.rpc('my_price_list'));
}

/** Update the logged-in user's profile (full_name, phone). */
export async function updateMyProfile({ fullName, phone }) {
  unwrap(await supabase.rpc('update_my_profile', {
    p_full_name: fullName || null,
    p_phone: phone || null,
  }));
}

/** Restaurant owner: update their restaurant's name / address / phone. */
export async function updateMyRestaurant({ name, phone, address, gstin }) {
  unwrap(await supabase.rpc('update_my_restaurant', {
    p_name: name || null,
    p_phone: phone || null,
    p_address: address || null,
    p_gstin: gstin || null,
  }));
}

/** Restaurant owner: update their delivery area (pincode, city, sector). */
export async function updateMyDeliveryArea({ pincode, cityId, sectorCode }) {
  unwrap(await supabase.rpc('update_my_delivery_area', {
    p_pincode: pincode || null,
    p_city_id: cityId || null,
    p_sector_code: sectorCode || null,
  }));
}

// ---------- Admin: audit log -------------------------------------------------

export async function listAuditLog({ table, rowId, userId, from, to, limit = 200 } = {}) {
  let query = supabase.from('audit_log')
    .select('*').order('created_at', { ascending: false }).limit(limit);
  if (table) query = query.eq('table_name', table);
  if (rowId) query = query.eq('row_id', rowId);
  if (userId) query = query.eq('user_id', userId);
  if (from) query = query.gte('created_at', from);
  if (to) query = query.lte('created_at', to);
  return unwrap(await query);
}

/** List all staff/admin user profiles. */
export async function listUsers({ role } = {}) {
  const users = unwrap(await supabase.rpc('admin_list_users', {}));
  return role ? users.filter((u) => u.role === role) : users;
}

// ---------- Company settings save --------------------------------------------

export async function saveCompanySettings(s) {
  const values = {
    name: s.name || null,
    address: s.address || null,
    phone: s.phone || null,
    email: s.email || null,
    gstin: s.gstin || null,
    fssai: s.fssai || null,
    support_phone: s.support_phone || null,
    support_email: s.support_email || null,
    support_whatsapp: s.support_whatsapp || null,
    invoice_prefix: s.invoice_prefix || null,
    invoice_note: s.invoice_note || null,
    show_prices_incl_gst: Boolean(s.show_prices_incl_gst),
    logo_url: s.logo_url || null,
    notify_customers: s.notify_customers !== undefined ? Boolean(s.notify_customers) : undefined,
    seo_title: s.seo_title !== undefined ? s.seo_title : undefined,
    seo_description: s.seo_description !== undefined ? s.seo_description : undefined,
    sms_from_label: s.sms_from_label || null,
  };
  // Remove undefined values so we don't overwrite DB fields unintentionally
  Object.keys(values).forEach((k) => values[k] === undefined && delete values[k]);
  return unwrap(await supabase.from('company_settings').update(values).not('id', 'is', null).select().single());
}

// ---------- Launch control ---------------------------------------------------

export async function getLaunchStatus() {
  return unwrap(await supabase.rpc('launch_status'));
}

export async function setSectorLive(sectorCode, live) {
  unwrap(await supabase.from('sectors').update({ is_active: Boolean(live) }).eq('code', sectorCode));
}

export async function saveLaunchModes({ pricingMode, stockMode }) {
  unwrap(await supabase.from('company_settings').update({
    pricing_mode: pricingMode || null,
    stock_mode: stockMode || null,
  }).not('id', 'is', null));
}

// ---------- Dashboard --------------------------------------------------------

export async function getDashboardStats(cityIdOrObj = null) {
  // Accept either getDashboardStats('city-uuid') or getDashboardStats({ cityId }) or getDashboardStats(null)
  const cityId = (cityIdOrObj && typeof cityIdOrObj === 'object') ? cityIdOrObj.cityId || null : cityIdOrObj || null;
  return unwrap(await supabase.rpc('admin_dashboard_stats', { p_city_id: cityId }));
}

// ---------- Fulfilment: pick list, expiry, write-off -------------------------

export async function getPickList({ date, warehouseId, slot } = {}) {
  return unwrap(await supabase.rpc('pick_list', {
    p_date: date || null,
    p_warehouse_id: warehouseId || null,
    p_slot: slot || null,
  }));
}

export async function getExpiringBatches({ warehouseId, daysAhead = 3 } = {}) {
  return unwrap(await supabase.rpc('expiring_batches', {
    p_warehouse_id: warehouseId || null,
    p_days_ahead: daysAhead,
  }));
}

export async function writeOffExpired(warehouseIdOrObj, extra = {}) {
  // Called as writeOffExpired(warehouseId) or writeOffExpired({ warehouseId, items, note })
  const warehouseId = (warehouseIdOrObj && typeof warehouseIdOrObj === 'object') ? warehouseIdOrObj.warehouseId : warehouseIdOrObj;
  const { items, note } = (warehouseIdOrObj && typeof warehouseIdOrObj === 'object') ? warehouseIdOrObj : extra;
  unwrap(await supabase.rpc('write_off_expired', {
    p_warehouse_id: warehouseId || null,
    p_items: items || [],
    p_note: note || null,
  }));
}

// ---------- Driver cash -------------------------------------------------------

export async function getDriverCashSummary({ driverId, from, to } = {}) {
  return unwrap(await supabase.rpc('driver_cash_summary', {
    p_driver_id: driverId || null,
    p_from: from || null,
    p_to: to || null,
  }));
}

export async function settleDriverCash(driverId, amount, note) {
  unwrap(await supabase.rpc('settle_driver_cash', {
    p_driver_id: driverId || null,
    p_amount: amount,
    p_note: note || null,
  }));
}

// ---------- Pricing: benchmark sources & prices ------------------------------

export async function listBenchmarkSources({ isActive } = {}) {
  let query = supabase.from('benchmark_sources').select('*').order('name');
  if (isActive !== undefined) query = query.eq('is_active', isActive);
  return unwrap(await query);
}

export async function saveBenchmarkSource({ id, name, url, isActive }) {
  const values = { name, url: url || null, is_active: Boolean(isActive ?? true) };
  if (id) return unwrap(await supabase.from('benchmark_sources').update(values).eq('id', id).select().single());
  return unwrap(await supabase.from('benchmark_sources').insert(values).select().single());
}

export async function listBenchmarkPrices({ sourceId, productId, from, to, limit = 200 } = {}) {
  let query = supabase.from('benchmark_prices').select('*, benchmark_sources(name), products(name, sku)')
    .order('date', { ascending: false }).limit(limit);
  if (sourceId) query = query.eq('source_id', sourceId);
  if (productId) query = query.eq('product_id', productId);
  if (from) query = query.gte('date', from);
  if (to) query = query.lte('date', to);
  return unwrap(await query);
}

export async function saveBenchmarkPrices(rows) {
  // rows: [{ source_id, product_id, price, date }]
  return unwrap(await supabase.from('benchmark_prices')
    .upsert(rows, { onConflict: 'source_id,product_id,date' }).select());
}

export async function listPriceHistory({ productId, from, to, limit = 200 } = {}) {
  let query = supabase.from('price_history').select('*, products(name, sku)')
    .order('changed_at', { ascending: false }).limit(limit);
  if (productId) query = query.eq('product_id', productId);
  if (from) query = query.gte('changed_at', from);
  if (to) query = query.lte('changed_at', to);
  return unwrap(await query);
}

export async function applyPrices(items, { reason, effectiveAt, force } = {}) {
  return unwrap(await supabase.rpc('apply_prices', {
    p_items: items || null,
    p_reason: reason || null,
    p_effective_at: effectiveAt || null,
    p_force: force || false,
  }));
}

export async function publishDuePrices() {
  return unwrap(await supabase.rpc('publish_due_prices'));
}

export async function listScheduledPrices({ productId, status } = {}) {
  let query = supabase.from('scheduled_prices').select('*, products(name, sku)').order('effective_from');
  if (productId) query = query.eq('product_id', productId);
  if (status) query = query.eq('status', status);
  return unwrap(await query);
}

export async function cancelScheduledPrice(id) {
  unwrap(await supabase.from('scheduled_prices').update({ status: 'cancelled' }).eq('id', id));
}

export async function saveSupplierQuote_legacy({ id, supplierId, productId, price, validFrom, validTo, note }) {
  const values = { supplier_id: supplierId, product_id: productId, price, valid_from: validFrom || null, valid_to: validTo || null, note: note || null };
  if (id) return unwrap(await supabase.from('supplier_quotes').update(values).eq('id', id).select().single());
  return unwrap(await supabase.from('supplier_quotes').insert(values).select().single());
}

export async function saveSupplierQuote(productId, quote, quoteDate) {
  return unwrap(await supabase.from('product_pricing').upsert(
    { product_id: productId, supplier_quote: quote === '' ? null : Number(quote), quote_date: quoteDate || null },
    { onConflict: 'product_id' }
  ).select().single());
}

export async function placeOrderFor(restaurantId, items) {
  return unwrap(await supabase.rpc('place_order_for', { p_restaurant_id: restaurantId, p_items: items }));
}

export async function saveProductPricing({ productId, costBasis, marginPct, price }) {
  return unwrap(await supabase.rpc('save_product_pricing', {
    p_product_id: productId, p_cost_basis: costBasis, p_margin_pct: marginPct, p_price: price || null,
  }));
}

export async function listProductPricing({ categoryId, productId } = {}) {
  let query = supabase.from('products').select('*, categories(name)').order('name');
  if (categoryId) query = query.eq('category_id', categoryId);
  if (productId) query = query.eq('id', productId);
  return unwrap(await query);
}

// ---------- Pricing rules ----------------------------------------------------

export async function listPricingRules({ isActive } = {}) {
  let query = supabase.from('pricing_rules').select('*').order('created_at', { ascending: false });
  if (isActive !== undefined) query = query.eq('is_active', isActive);
  return unwrap(await query);
}

export async function savePricingRule(r) {
  // Supports both legacy discount-rules schema and the category-based pricing-rules schema.
  // Fields that are undefined are omitted so a partial update (closing effective_to) doesn't
  // blank out other columns.
  const values = {};
  if (r.category_id !== undefined) values.category_id = r.category_id ?? null;
  if (r.markup_pct !== undefined) values.markup_pct = Number(r.markup_pct) || 0;
  if (r.min_markup_pct !== undefined) values.min_markup_pct = Number(r.min_markup_pct) || 0;
  if (r.wastage_pct !== undefined) values.wastage_pct = Number(r.wastage_pct) || 0;
  if (r.handling_per_kg !== undefined) values.handling_per_kg = Number(r.handling_per_kg) || 0;
  if (r.packing_per_unit !== undefined) values.packing_per_unit = Number(r.packing_per_unit) || 0;
  if (r.transport_per_kg !== undefined) values.transport_per_kg = Number(r.transport_per_kg) || 0;
  if (r.market_fee_pct !== undefined) values.market_fee_pct = Number(r.market_fee_pct) || 0;
  if (r.other_cost_pct !== undefined) values.other_cost_pct = Number(r.other_cost_pct) || 0;
  if (r.rounding_step !== undefined) values.rounding_step = Number(r.rounding_step) || 1;
  if (r.round_mode !== undefined) values.round_mode = r.round_mode || 'nearest';
  if (r.benchmark_cap_pct !== undefined) values.benchmark_cap_pct = r.benchmark_cap_pct != null && r.benchmark_cap_pct !== '' ? Number(r.benchmark_cap_pct) : null;
  if (r.benchmark_source_id !== undefined) values.benchmark_source_id = r.benchmark_source_id ?? null;
  if (r.cost_method !== undefined) values.cost_method = r.cost_method || 'weighted_avg_30d';
  if (r.guard_mode !== undefined) values.guard_mode = r.guard_mode || 'warn';
  if (r.effective_from !== undefined) values.effective_from = r.effective_from || null;
  if (r.effective_to !== undefined) values.effective_to = r.effective_to ?? null;
  if (r.note !== undefined) values.note = r.note || null;
  // Legacy discount-rule fields
  if (r.name !== undefined) values.name = r.name || null;
  if (r.rule_type !== undefined) values.rule_type = r.rule_type || null;
  if (r.product_ids !== undefined) values.product_ids = r.product_ids || null;
  if (r.category_ids !== undefined) values.category_ids = r.category_ids || null;
  if (r.customer_ids !== undefined) values.customer_ids = r.customer_ids || null;
  if (r.sector_codes !== undefined) values.sector_codes = r.sector_codes || null;
  if (r.discount_pct !== undefined) values.discount_pct = r.discount_pct || null;
  if (r.fixed_price !== undefined) values.fixed_price = r.fixed_price || null;
  if (r.valid_from !== undefined) values.valid_from = r.valid_from || null;
  if (r.valid_to !== undefined) values.valid_to = r.valid_to || null;
  if (r.is_active !== undefined) values.is_active = Boolean(r.is_active ?? true);
  if (r.id) return unwrap(await supabase.from('pricing_rules').update(values).eq('id', r.id).select().single());
  return unwrap(await supabase.from('pricing_rules').insert(values).select().single());
}

// ---------- Sector terms -------------------------------------------------------

export async function saveSectorTerms(sectorCode, fields) {
  // Accepts (code, fields) — updates the sectors row directly.
  // Also handles legacy single-object call for back-compat.
  if (typeof sectorCode === 'object') {
    // Legacy: { sectorCode, paymentTerms, creditDays, minOrderValue }
    const o = sectorCode;
    return saveSectorTerms(o.sectorCode, { credit_days: o.creditDays, min_order_value: o.minOrderValue });
  }
  const values = {};
  const f = fields || {};
  const numOrNull = (v) => (v === '' || v == null) ? null : Number(v);
  if ('min_order_value'            in f) values.min_order_value            = numOrNull(f.min_order_value);
  if ('delivery_fee_below_mov'     in f) values.delivery_fee_below_mov     = numOrNull(f.delivery_fee_below_mov);
  if ('credit_days'                in f) values.credit_days                = numOrNull(f.credit_days);
  if ('credit_limit'               in f) values.credit_limit               = numOrNull(f.credit_limit);
  if ('block_credit_when_overdue'  in f) values.block_credit_when_overdue  = Boolean(f.block_credit_when_overdue);
  if ('customer_edit_window_minutes' in f) values.customer_edit_window_minutes = numOrNull(f.customer_edit_window_minutes);
  if ('needs_po_reference'         in f) values.needs_po_reference         = Boolean(f.needs_po_reference);
  if ('needs_order_approval'       in f) values.needs_order_approval       = Boolean(f.needs_order_approval);
  if ('can_self_register'          in f) values.can_self_register          = Boolean(f.can_self_register);
  if ('is_active'                  in f) values.is_active                  = Boolean(f.is_active);
  return unwrap(await supabase.from('sectors').update(values).eq('code', sectorCode));
}

// ---------- Foundation: city / warehouse save --------------------------------

export async function saveCity({ id, name, stateCode, isActive }) {
  const values = { name, state_code: stateCode || null, is_active: Boolean(isActive ?? true) };
  if (id) return unwrap(await supabase.from('cities').update(values).eq('id', id).select().single());
  return unwrap(await supabase.from('cities').insert(values).select().single());
}

export async function saveWarehouse({ id, name, cityId, address, phone, isActive }) {
  const values = {
    name, city_id: cityId || null, address: address || null,
    phone: phone || null, is_active: Boolean(isActive ?? true),
  };
  if (id) return unwrap(await supabase.from('warehouses').update(values).eq('id', id).select().single());
  return unwrap(await supabase.from('warehouses').insert(values).select().single());
}

// ---------- Service zones ----------------------------------------------------

export async function listServiceZones({ warehouseId, cityId } = {}) {
  let query = supabase.from('service_zones').select('*').order('pincode');
  if (warehouseId) query = query.eq('warehouse_id', warehouseId);
  else if (cityId) query = query.eq('city_id', cityId);
  return unwrap(await query);
}

export async function saveServiceZone({ id, pincode, area_name, warehouse_id, is_active }) {
  const values = {
    pincode: pincode || null,
    area_name: area_name || null,
    warehouse_id: warehouse_id || null,
    is_active: Boolean(is_active ?? true),
  };
  if (id) return unwrap(await supabase.from('service_zones').update(values).eq('id', id).select().single());
  return unwrap(await supabase.from('service_zones').insert(values).select().single());
}

export async function deleteServiceZone(id) {
  unwrap(await supabase.from('service_zones').delete().eq('id', id));
}

// ---------- Goods receipt notes (GRN) ----------------------------------------

export async function listGoodsReceipts({ warehouseId, supplierId, from, to, limit = 100 } = {}) {
  let query = supabase.from('goods_receipts')
    .select('*, suppliers(name), warehouses(name), purchase_orders(reference_number)').order('receipt_date', { ascending: false }).limit(limit);
  if (warehouseId) query = query.eq('warehouse_id', warehouseId);
  if (supplierId) query = query.eq('supplier_id', supplierId);
  if (from) query = query.gte('receipt_date', from);
  if (to) query = query.lte('receipt_date', to);
  return unwrap(await query);
}

export async function uploadBillPhoto(grnId, file) {
  const ext = file.type === 'image/png' ? 'png' : file.type === 'application/pdf' ? 'pdf' : 'jpg';
  const path = `${grnId}-bill-${Date.now()}.${ext}`;
  unwrap(await supabase.storage.from(config.billBucket || 'grn-bills').upload(path, file, { contentType: file.type }));
  unwrap(await supabase.from('goods_receipts').update({ bill_photo_path: path }).eq('id', grnId));
  return path;
}

export function billPhotoUrl(path, seconds = 600) {
  if (!path) return null;
  return supabase.storage.from(config.billBucket || 'grn-bills').createSignedUrl(path, seconds).then(({ data, error }) => {
    if (error) throw new Error(error.message);
    return data.signedUrl;
  });
}

// ---------- Trips (own fulfilment, not Fleetbase) ----------------------------

export async function getTrip(id) {
  return unwrap(await supabase.from('trips').select('*, profiles(full_name), vehicles(registration)').eq('id', id).single());
}

export async function createTrip({ driverId, vehicleId, warehouseId, date, slot, orderIds }) {
  return unwrap(await supabase.rpc('create_trip', {
    p_driver_id: driverId, p_vehicle_id: vehicleId || null,
    p_warehouse_id: warehouseId || null,
    p_date: date, p_slot: slot || 'morning',
    p_order_ids: orderIds || [],
  }));
}

export async function setTripStatus(id, status) {
  unwrap(await supabase.rpc('set_trip_status', { p_trip_id: id, p_status: status }));
}

export async function listVehicles({ isActive } = {}) {
  let query = supabase.from('vehicles').select('*').order('registration');
  if (isActive !== undefined) query = query.eq('is_active', isActive);
  return unwrap(await query);
}

// ---------- Delivery charges -------------------------------------------------

export async function listDeliveryCharges({ cityId } = {}) {
  let query = supabase.from('delivery_charge_rules').select('*, cities(name)').order('slot');
  if (cityId) query = query.eq('city_id', cityId);
  return unwrap(await query);
}

export async function saveDeliveryCharge({ id, city_id, slot, fee, free_above, is_active }) {
  const values = {
    city_id: city_id || null,
    slot: slot || null,
    fee: Number(fee) || 0,
    free_above: (free_above !== '' && free_above != null) ? Number(free_above) : null,
    is_active: Boolean(is_active ?? true),
  };
  if (id) return unwrap(await supabase.from('delivery_charge_rules').update(values).eq('id', id).select().single());
  return unwrap(await supabase.from('delivery_charge_rules').insert(values).select().single());
}

export async function deleteDeliveryCharge(id) {
  unwrap(await supabase.from('delivery_charge_rules').delete().eq('id', id));
}

// ---------- Inventory: stock movements & warehouse stock ---------------------

export async function listStockMovements({ productId, warehouseId, from, to, limit = 200 } = {}) {
  let query = supabase.from('stock_movements').select('*, products(name, sku), warehouses(name)')
    .order('created_at', { ascending: false }).limit(limit);
  if (productId) query = query.eq('product_id', productId);
  if (warehouseId) query = query.eq('warehouse_id', warehouseId);
  if (from) query = query.gte('created_at', from);
  if (to) query = query.lte('created_at', to);
  return unwrap(await query);
}

export async function listWarehouseStock({ warehouseId, categoryId, lowStock } = {}) {
  let query = supabase.from('warehouse_stock')
    .select('*, products(name, sku, categories(name)), warehouses(name)').order('product_id');
  if (warehouseId) query = query.eq('warehouse_id', warehouseId);
  if (categoryId) query = query.eq('products.category_id', categoryId);
  if (lowStock) query = query.lt('qty_on_hand', 'reorder_point');
  return unwrap(await query);
}

// ---------- Team / RBAC ------------------------------------------------------

export async function listTeamRoles() {
  return unwrap(await supabase.from('team_roles').select('*').order('sort_order'));
}

export async function listRolePermissions() {
  return unwrap(await supabase.from('role_permissions').select('*').order('module').order('action'));
}

export async function setRolePermission(teamRole, module, action, isAllowed) {
  if (isAllowed) {
    unwrap(await supabase.from('role_permissions').upsert({ team_role: teamRole, module, action }).select());
  } else {
    unwrap(await supabase.from('role_permissions').delete().eq('team_role', teamRole).eq('module', module).eq('action', action));
  }
}

export async function setTeamMember(userId, { role, teamRole, cityId, warehouseId, isActive }) {
  unwrap(await supabase.rpc('admin_set_team_member', {
    p_user: userId,
    p_role: role || null,
    p_team_role: teamRole || null,
    p_city_id: cityId || null,
    p_warehouse_id: warehouseId || null,
    p_is_active: isActive ?? null,
  }));
}

export async function inviteStaff({ email, fullName, phone, role, teamRole, cityId, warehouseId }) {
  const { data, error } = await supabase.functions.invoke('invite-staff', {
    body: {
      email, full_name: fullName, phone: phone || null,
      role, team_role: teamRole || null,
      city_id: cityId || null, warehouse_id: warehouseId || null,
      redirect_to: `${webRoot}reset.html?role=${role}`,
    },
  });
  if (error) {
    let message = error.message;
    try { message = (await error.context?.json())?.error ?? message; } catch { /* keep default */ }
    throw new Error(message);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

// ---------- Reports ----------------------------------------------------------

export async function salesReport({ groupBy = 'day', cityId = null, from = null, to = null } = {}) {
  return unwrap(await supabase.rpc('sales_report', {
    p_group_by: groupBy,
    p_city_id: cityId || null,
    p_from: from || null,
    p_to: to || null,
  }));
}

export async function receivablesTrend() {
  return unwrap(await supabase.rpc('receivables_trend'));
}
