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

// ---------- Catalogue --------------------------------------------------------

export async function listCategories() {
  return unwrap(await supabase.from('categories').select('*').order('sort_order').order('name'));
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
    .select('*').eq('order_id', orderId).order('created_at'));
}

/**
 * items: [{ product_id, quantity }]. Returns { id, order_number, total_amount, delivery_fee }.
 * options: { notes, deliveryDate (YYYY-MM-DD), slot, paymentMethod, poReference }
 */
export async function placeOrder(items, { notes, deliveryDate, slot = 'morning', paymentMethod = 'cod', poReference, outletId, couponCode } = {}) {
  return unwrap(await supabase.rpc('place_order', {
    p_items: items,
    p_notes: notes || null,
    p_delivery_date: deliveryDate || null,
    p_delivery_slot: slot,
    p_payment_method: paymentMethod,
    p_po_reference: poReference || null,
    p_outlet_id: outletId || null,   // migration 020: null = the member's outlet, else the primary
    p_coupon_code: couponCode || null,   // migration 021
  }));
}

/**
 * The customer's trading terms for the cart:
 * { min_order_value, delivery_fee_below_mov, credit_days, needs_po_reference, sector_name, delivers }
 */
export async function getMyOrderTerms() {
  return unwrap(await supabase.rpc('my_order_terms'));
}

/** One order with its items (RLS decides who may see it). */
export async function getOrder(orderId) {
  return unwrap(await supabase.from('orders').select(ORDER_SELECT).eq('id', orderId).maybeSingle());
}

export async function setOrderStatus(orderId, status, note) {
  unwrap(await supabase.rpc('set_order_status', { p_order_id: orderId, p_new: status, p_note: note || null }));
}

export async function assignDelivery(orderId, deliveryUserId) {
  unwrap(await supabase.rpc('assign_delivery', { p_order_id: orderId, p_delivery_user: deliveryUserId }));
}

// ---------- Account ----------------------------------------------------------

export async function updateMyProfile({ fullName, phone }) {
  unwrap(await supabase.rpc('update_my_profile', { p_full_name: fullName, p_phone: phone }));
}

export async function updateMyRestaurant({ name, address, phone, gstin, fssai }) {
  unwrap(await supabase.rpc('update_my_restaurant',
    { p_name: name, p_address: address, p_phone: phone, p_gstin: gstin, p_fssai: fssai }));
}

/** Customer changes city / pin code. Returns { delivers } — false when no warehouse serves the pin code. */
export async function updateMyDeliveryArea({ cityId, pincode }) {
  return unwrap(await supabase.rpc('update_my_delivery_area', { p_city_id: cityId, p_pincode: pincode || null }));
}

// ---------- Cities, warehouses, zones (public read of cities; admin writes) --

/** Active cities (every visitor may read these, for the sign-up form and pin-code check). */
export async function listCities() {
  return unwrap(await supabase.from('cities').select('*').order('sort_order').order('name'));
}

export async function saveCity(city) {
  const row = { name: city.name.trim(), state_code: (city.state_code || '37').trim(), is_active: city.is_active ?? true, sort_order: Number(city.sort_order) || 0 };
  const query = city.id ? supabase.from('cities').update(row).eq('id', city.id) : supabase.from('cities').insert(row);
  unwrap(await query);
}

export async function listWarehouses() {
  return unwrap(await supabase.from('warehouses').select('*, cities(name)').order('name'));
}

export async function saveWarehouse(warehouse) {
  const row = {
    city_id: warehouse.city_id, name: warehouse.name.trim(), address: warehouse.address?.trim() || '',
    phone: warehouse.phone?.trim() || null, is_default: Boolean(warehouse.is_default), is_active: warehouse.is_active ?? true,
  };
  const query = warehouse.id ? supabase.from('warehouses').update(row).eq('id', warehouse.id) : supabase.from('warehouses').insert(row);
  unwrap(await query);
}

export async function listServiceZones() {
  return unwrap(await supabase.from('service_zones').select('*').order('pincode'));
}

export async function saveServiceZone(zone) {
  const row = { warehouse_id: zone.warehouse_id, pincode: zone.pincode.trim(), area_name: zone.area_name?.trim() || '', is_active: zone.is_active ?? true };
  const query = zone.id ? supabase.from('service_zones').update(row).eq('id', zone.id) : supabase.from('service_zones').insert(row);
  unwrap(await query);
}

export async function deleteServiceZone(id) {
  unwrap(await supabase.from('service_zones').delete().eq('id', id));
}

/** Logged-out pin-code check for the website: { delivers, city, area }. */
export async function checkPincode(pincode) {
  return unwrap(await supabase.rpc('check_pincode', { p_pincode: pincode.trim() }));
}

// ---------- Sectors (customer types and their trading terms) ----------------

export async function listSectors() {
  return unwrap(await supabase.from('sectors').select('*').order('sort_order'));
}

/** Only the editable terms; code and name are fixed. credit_limit '' / null = no limit (migration 015). */
export async function saveSectorTerms(code, terms) {
  unwrap(await supabase.from('sectors').update({
    min_order_value: Number(terms.min_order_value) || 0,
    delivery_fee_below_mov: Number(terms.delivery_fee_below_mov) || 0,
    credit_days: Number(terms.credit_days) || 0,
    credit_limit: terms.credit_limit === '' || terms.credit_limit == null ? null : Number(terms.credit_limit),
    block_credit_when_overdue: terms.block_credit_when_overdue ?? true,
    customer_edit_window_minutes: terms.customer_edit_window_minutes === '' || terms.customer_edit_window_minutes == null ? 15 : Math.max(0, Math.min(1440, Number(terms.customer_edit_window_minutes))),
    needs_po_reference: Boolean(terms.needs_po_reference),
    needs_order_approval: Boolean(terms.needs_order_approval),
    can_self_register: Boolean(terms.can_self_register),
    is_active: terms.is_active ?? true,
  }).eq('code', code));
}

// ---------- Launch control (migration 014) -----------------------------------

/** Switch a sector live (true) or off (false): off = no sign-up, no orders. settings:edit. */
export async function setSectorLive(code, live) {
  unwrap(await supabase.from('sectors').update({ is_active: Boolean(live) }).eq('code', code));
}

/** The two company-wide modes. settings:edit (company_settings policy). */
export async function saveLaunchModes({ pricingMode, stockMode }) {
  unwrap(await supabase.from('company_settings').update({ pricing_mode: pricingMode, stock_mode: stockMode }).eq('id', true));
}

/** What the Launch screen shows: modes, product counts and per-sector customer / order counts. settings:view. */
export async function getLaunchStatus() {
  return unwrap(await supabase.rpc('launch_status'));
}

// ---------- Team roles & permission matrix -----------------------------------

export async function listTeamRoles() {
  return unwrap(await supabase.from('team_roles').select('*').order('sort_order'));
}

/** Every allowed (team_role, module, action) row. */
export async function listRolePermissions() {
  return unwrap(await supabase.from('role_permissions').select('*'));
}

/** Tick or untick one box in the matrix (super admin only, enforced by RLS). */
export async function setRolePermission(teamRole, module, action, allowed) {
  const query = allowed
    ? supabase.from('role_permissions').insert({ team_role: teamRole, module, action })
    : supabase.from('role_permissions').delete().eq('team_role', teamRole).eq('module', module).eq('action', action);
  unwrap(await query);
}

// ---------- Audit log --------------------------------------------------------

/** Latest changes, newest first. filters: { table, userId, limit } */
export async function listAuditLog({ table, userId, limit = 200 } = {}) {
  let query = supabase.from('audit_log').select('*').order('id', { ascending: false }).limit(limit);
  if (table) query = query.eq('table_name', table);
  if (userId) query = query.eq('changed_by', userId);
  return unwrap(await query);
}

// ---------- Product availability per city ------------------------------------

export async function listProductAvailability() {
  return unwrap(await supabase.from('product_city_availability').select('*'));
}

/** Hide (false) or show (true) one product in one city. */
export async function setProductAvailability(productId, cityId, isAvailable) {
  unwrap(await supabase.from('product_city_availability')
    .upsert({ product_id: productId, city_id: cityId, is_available: isAvailable }, { onConflict: 'product_id,city_id' }));
}

/** Company details used on invoices (readable by every signed-in user). */
export async function getCompanySettings() {
  return unwrap(await supabase.from('company_settings').select('*').eq('id', true).single());
}

export async function saveCompanySettings(settings) {
  unwrap(await supabase.from('company_settings').update(settings).eq('id', true));
}

/**
 * Make the signed-in user the FIRST admin. Returns true on success, false when
 * an admin already exists (the database refuses; see migration 005).
 */
export async function claimFirstAdmin() {
  return unwrap(await supabase.rpc('claim_first_admin'));
}

// ---------- Admin: catalogue management --------------------------------------

export async function saveProduct(product) {
  const row = {
    sku: product.sku.trim(),
    name: product.name.trim(),
    description: product.description?.trim() || null,
    category_id: product.category_id,
    price: Number(product.price),
    unit: product.unit.trim(),
    min_order_qty: Number(product.min_order_qty) || 1,
    in_stock: Boolean(product.in_stock),
    is_active: Boolean(product.is_active),
    photo_path: product.photo_path || null,
    brand: product.brand?.trim() || null,
    market_price: product.market_price === '' || product.market_price == null ? null : Number(product.market_price),
    gst_rate: Number(product.gst_rate) || 0,
    low_stock_threshold: Number(product.low_stock_threshold) || 0,
    hsn_code: product.hsn_code || null,
    pack_size: Number(product.pack_size) > 0 ? Number(product.pack_size) : 1,
    pack_unit: product.pack_unit || 'kg',
    // Catalogue + (migration 010)
    grade: product.grade?.trim() || null,
    origin: product.origin?.trim() || null,
    veg_type: product.veg_type || null,
    shelf_life_days: product.shelf_life_days === '' || product.shelf_life_days == null ? null : Number(product.shelf_life_days),
    storage_note: product.storage_note?.trim() || null,
    parent_product_id: product.parent_product_id || null,
    variant_label: product.variant_label?.trim() || null,
    sold_by_weight: Boolean(product.sold_by_weight),
    weight_tolerance_pct: Number(product.weight_tolerance_pct) >= 0 ? Number(product.weight_tolerance_pct) : 10,
  };
  // A price published from the board stays as the board set it; the form only
  // changes it when the product is priced by hand. In simple pricing (Settings →
  // Launch) the form passes 'manual' and the typed price wins from now on.
  if (product.price_source === 'rule' && product.id) { delete row.price; delete row.market_price; }
  if (product.price_source === 'manual' && product.id) row.price_source = 'manual';
  const query = product.id
    ? supabase.from('products').update(row).eq('id', product.id).select().single()
    : supabase.from('products').insert(row).select().single();
  return unwrap(await query);
}

export async function setProductFlags(id, flags) {
  unwrap(await supabase.from('products').update(flags).eq('id', id));
}

/** Upload an image and return its storage path (store it in photo_path). */
export async function uploadProductPhoto(file) {
  const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[file.type];
  if (!extension) throw new Error('Please choose a JPG, PNG or WebP image.');
  if (file.size > 5 * 1024 * 1024) throw new Error('Image is larger than 5 MB.');
  const path = `${crypto.randomUUID()}.${extension}`;
  unwrap(await supabase.storage.from(config.photoBucket).upload(path, file, { contentType: file.type }));
  return path;
}

/** Create or rename a category. parent_id null = top level (two levels only; the database checks). */
export async function saveCategory(category) {
  const row = { name: category.name.trim(), sort_order: Number(category.sort_order) || 0, parent_id: category.parent_id || null };
  const query = category.id
    ? supabase.from('categories').update(row).eq('id', category.id)
    : supabase.from('categories').insert(row);
  unwrap(await query);
}

export async function deleteCategory(id) {
  unwrap(await supabase.from('categories').delete().eq('id', id));
}

// ---------- Admin: warehouse & inventory -------------------------------------

export async function listSuppliers() {
  return unwrap(await supabase.from('suppliers').select('*').order('name'));
}

export async function saveSupplier(supplier) {
  const row = {
    name: supplier.name.trim(),
    contact: supplier.contact?.trim() || null,
    phone: supplier.phone?.trim() || null,
    notes: supplier.notes?.trim() || null,
    is_active: supplier.is_active ?? true,
  };
  const query = supplier.id
    ? supabase.from('suppliers').update(row).eq('id', supplier.id)
    : supabase.from('suppliers').insert(row);
  unwrap(await query);
}

// Receiving goods lives in the Procurement section below (receiveGoods → receive_goods, migration 011):
// every receipt is a GRN, whether it is against a PO, a mandi cash purchase or a direct delivery.
// The older receive_stock() function still exists in the database but the app no longer calls it.

/** Set one warehouse's stock to an exact count. reason: 'adjustment' | 'wastage' | 'returned'. */
export async function adjustStock(productId, newQty, reason, note, warehouseId) {
  unwrap(await supabase.rpc('adjust_stock', {
    p_product_id: productId, p_new_qty: newQty, p_reason: reason, p_note: note || null, p_warehouse_id: warehouseId || null,
  }));
}

/** Movement ledger, newest first. Both filters optional. */
export async function listStockMovements({ productId, warehouseId, limit = 50 } = {}) {
  let query = supabase.from('stock_movements')
    .select('*, suppliers(name), orders(order_number)')
    .order('created_at', { ascending: false }).limit(limit);
  if (productId) query = query.eq('product_id', productId);
  if (warehouseId) query = query.eq('warehouse_id', warehouseId);
  return unwrap(await query);
}

/** Stock on hand per warehouse: [{ warehouse_id, product_id, qty }]. RLS limits to the caller's scope. */
export async function listWarehouseStock(warehouseId) {
  let query = supabase.from('warehouse_stock').select('*');
  if (warehouseId) query = query.eq('warehouse_id', warehouseId);
  return unwrap(await query);
}

// ---------- Admin: people ----------------------------------------------------

export async function listRestaurants() {
  return unwrap(await supabase.from('restaurants').select('*').order('created_at', { ascending: false }));
}

/** Approve / suspend / reinstate. Needs customers:approve (set_customer_status re-checks). */
export async function setRestaurantStatus(id, status) {
  unwrap(await supabase.rpc('set_customer_status', { p_restaurant_id: id, p_status: status }));
}

/**
 * Sector, city, warehouse, pin code and per-customer overrides of the sector
 * terms (empty string = use the sector default). Needs customers:edit.
 */
export async function saveCustomerTerms(id, terms) {
  const orNull = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
  unwrap(await supabase.from('restaurants').update({
    sector_code: terms.sector_code,
    city_id: terms.city_id,
    warehouse_id: terms.warehouse_id || null,
    pincode: terms.pincode?.trim() || null,
    min_order_value: orNull(terms.min_order_value),
    delivery_fee_below_mov: orNull(terms.delivery_fee_below_mov),
    credit_days: orNull(terms.credit_days),
    credit_limit: orNull(terms.credit_limit),
    needs_order_approval: terms.needs_order_approval === 'true' ? true : terms.needs_order_approval === 'false' ? false : null,   // migration 020
  }).eq('id', id));
}

/** Open position per customer: [{ restaurant_id, outstanding, unpaid_orders }] (open items minus credit on account, migration 015). */
export async function listOutstandingBalances() {
  return unwrap(await supabase.rpc('admin_outstanding_balances'));
}

export async function listUsers() {
  return unwrap(await supabase.rpc('admin_list_users'));
}

/**
 * Invite a new admin or delivery person by email (Edge Function invite-staff).
 * Supabase emails them a link; they set a password on reset.html and sign in.
 */
export async function inviteStaff({ email, role, fullName, teamRole }) {
  const { data, error } = await supabase.functions.invoke('invite-staff', {
    body: { email, role, full_name: fullName, team_role: teamRole || null, redirect_to: `${webRoot}reset.html?role=${role}` },
  });
  if (error) {
    // The function returns a readable message in the JSON body; surface it.
    let message = error.message;
    try { message = (await error.context?.json())?.error ?? message; } catch { /* keep default */ }
    throw new Error(message);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

/**
 * Login state per customer (migration 016): [{ restaurant_id, owner_id, email, email_confirmed,
 * confirmation_sent_at, last_sign_in_at, user_created_at }]. customers:view, in scope.
 */
export async function listCustomerLogins() {
  return unwrap(await supabase.rpc('admin_customer_logins'));
}

/**
 * The customer-access Edge Function (customers:approve): get a stuck customer signing in.
 *   action: 'confirm_email' | 'resend_confirmation' | 'password_link' | 'set_password'
 * Returns the function's JSON ({ ok, action, email, link?, … }); throws its error message.
 */
export async function customerAccess(action, restaurantId, { password } = {}) {
  const { data, error } = await supabase.functions.invoke('customer-access', {
    body: { action, restaurant_id: restaurantId, password: password || undefined, redirect_to: `${webRoot}reset.html?role=restaurant` },
  });
  if (error) {
    let message = error.message;
    try { message = (await error.context?.json())?.error ?? message; } catch { /* keep default */ }
    throw new Error(message);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

export async function setUserRole(userId, role, isActive) {
  unwrap(await supabase.rpc('admin_set_user_role', { p_user: userId, p_role: role, p_active: isActive }));
}

/** Role, team role, scope and active flag in one call (Team screen). */
export async function setTeamMember(userId, { role, isActive, teamRole, cityId, warehouseId }) {
  unwrap(await supabase.rpc('admin_set_team_member', {
    p_user: userId, p_role: role, p_active: isActive,
    p_team_role: teamRole || null, p_city_id: cityId || null, p_warehouse_id: warehouseId || null,
  }));
}

/** Dashboard numbers, optionally narrowed to one city (migration 019; null = whole scope). */
export async function getDashboardStats(cityId = null) {
  return unwrap(await supabase.rpc('admin_dashboard_stats', { p_city_id: cityId || null }));
}

// ---------- Pricing engine (migration 009) -----------------------------------
// Staff-only tables: every read here needs pricing:view, writes pricing:edit,
// publishing pricing:approve. The database checks; the screens only hide.

/** HSN list for the product form and invoices (any signed-in user). */
export async function listHsnCodes() {
  return unwrap(await supabase.from('hsn_codes').select('*').order('code'));
}

/** The board: one object per active product with inputs, costs, benchmark and the computed price. */
export async function listPriceBoard(categoryId) {
  return unwrap(await supabase.rpc('price_board', { p_category_id: categoryId || null }));
}

/**
 * Publish prices. items = [{ product_id, price? }] (no price = the suggestion).
 * options: { reason, effectiveAt (ISO string, future = scheduled), force (publish past a warning) }.
 * Returns { applied, scheduled }.
 */
export async function applyPrices(items, { reason, effectiveAt, force = false } = {}) {
  return unwrap(await supabase.rpc('apply_prices', {
    p_items: items, p_reason: reason || null, p_effective_at: effectiveAt || null, p_force: force,
  }));
}

/** Apply any scheduled prices whose time has come; returns how many. */
export async function publishDuePrices() {
  return unwrap(await supabase.rpc('publish_due_prices'));
}

export async function listScheduledPrices() {
  return unwrap(await supabase.from('scheduled_prices').select('*').eq('status', 'pending').order('effective_at'));
}

export async function cancelScheduledPrice(id) {
  unwrap(await supabase.rpc('cancel_scheduled_price', { p_id: id }));
}

/** Every rule row (global + per category, all effective dates), newest first. */
export async function listPricingRules() {
  return unwrap(await supabase.from('pricing_rules').select('*, categories(name)').order('effective_from', { ascending: false }));
}

/** Insert or update one rule row. Pass id to update. Numbers may arrive as strings from a form. */
export async function savePricingRule(rule) {
  const n = (v) => (v === '' || v == null ? null : Number(v));
  const row = {
    category_id: rule.category_id || null,
    markup_pct: n(rule.markup_pct) ?? 0,
    min_markup_pct: n(rule.min_markup_pct) ?? 0,
    wastage_pct: n(rule.wastage_pct) ?? 0,
    handling_per_kg: n(rule.handling_per_kg) ?? 0,
    packing_per_unit: n(rule.packing_per_unit) ?? 0,
    transport_per_kg: n(rule.transport_per_kg) ?? 0,
    market_fee_pct: n(rule.market_fee_pct) ?? 0,
    other_cost_pct: n(rule.other_cost_pct) ?? 0,
    rounding_step: n(rule.rounding_step) ?? 1,
    round_mode: rule.round_mode || 'nearest',
    benchmark_cap_pct: n(rule.benchmark_cap_pct),
    benchmark_source_id: rule.benchmark_source_id || null,
    cost_method: rule.cost_method || 'weighted_avg_30d',
    guard_mode: rule.guard_mode || 'warn',
    effective_from: rule.effective_from,
    effective_to: rule.effective_to || null,
    note: rule.note?.trim() || null,
  };
  const query = rule.id
    ? supabase.from('pricing_rules').update(row).eq('id', rule.id).select().single()
    : supabase.from('pricing_rules').insert(row).select().single();
  return unwrap(await query);
}

export async function listProductPricing() {
  return unwrap(await supabase.from('product_pricing').select('*'));
}

/**
 * Save a product's override (upsert on product_id). Every field is optional;
 * blank = "use the category rule". Returns the saved row.
 */
export async function saveProductPricing(productId, o) {
  const n = (v) => (v === '' || v == null ? null : Number(v));
  const row = {
    product_id: productId,
    pricing_mode: o.pricing_mode || 'rule',
    markup_pct: n(o.markup_pct), min_markup_pct: n(o.min_markup_pct), wastage_pct: n(o.wastage_pct),
    yield_pct: n(o.yield_pct) ?? 100,
    handling_per_kg: n(o.handling_per_kg), packing_per_unit: n(o.packing_per_unit), transport_per_kg: n(o.transport_per_kg),
    market_fee_pct: n(o.market_fee_pct), other_cost_pct: n(o.other_cost_pct),
    rounding_step: n(o.rounding_step), round_mode: o.round_mode || null,
    benchmark_cap_pct: n(o.benchmark_cap_pct), benchmark_source_id: o.benchmark_source_id || null,
    fixed_margin_amount: n(o.fixed_margin_amount),
    manual_price: n(o.manual_price), manual_reason: o.manual_reason?.trim() || null,
    cost_method: o.cost_method || null, manual_cost: n(o.manual_cost),
    supplier_quote: n(o.supplier_quote), quote_date: o.quote_date || null,
  };
  return unwrap(await supabase.from('product_pricing').upsert(row, { onConflict: 'product_id' }).select().single());
}

/** Today's buying price for one product, straight from the board. */
export async function saveSupplierQuote(productId, quote, quoteDate) {
  return unwrap(await supabase.from('product_pricing')
    .upsert({ product_id: productId, supplier_quote: quote === '' || quote == null ? null : Number(quote), quote_date: quoteDate }, { onConflict: 'product_id' })
    .select().single());
}

export async function listBenchmarkSources() {
  return unwrap(await supabase.from('benchmark_sources').select('*').order('sort_order').order('name'));
}

export async function saveBenchmarkSource(source) {
  const row = { code: source.code.trim().toLowerCase(), name: source.name.trim(), url: source.url?.trim() || null,
                is_active: source.is_active !== false, sort_order: Number(source.sort_order) || 0 };
  const query = source.id
    ? supabase.from('benchmark_sources').update(row).eq('id', source.id).select().single()
    : supabase.from('benchmark_sources').insert(row).select().single();
  return unwrap(await query);
}

/** Benchmark entries, newest first. filters: { productId, sourceId, since (YYYY-MM-DD), limit } */
export async function listBenchmarkPrices({ productId, sourceId, since, limit = 500 } = {}) {
  let query = supabase.from('benchmark_prices').select('*').order('price_date', { ascending: false }).limit(limit);
  if (productId) query = query.eq('product_id', productId);
  if (sourceId) query = query.eq('source_id', sourceId);
  if (since) query = query.gte('price_date', since);
  return unwrap(await query);
}

/** Enter or correct market rates: rows = [{ source_id, product_id, price_date, price, market? }]. Same day overwrites. */
export async function saveBenchmarkPrices(rows) {
  if (!rows.length) return [];
  return unwrap(await supabase.from('benchmark_prices').upsert(rows, { onConflict: 'source_id,product_id,price_date' }).select());
}

/** Published price changes for one product, newest first (the chart and the "why" trail). */
export async function listPriceHistory(productId, limit = 60) {
  return unwrap(await supabase.from('price_history').select('*').eq('product_id', productId).order('created_at', { ascending: false }).limit(limit));
}

// ---------- Catalogue + (migration 010) --------------------------------------

/**
 * Bulk create / update products from csv-import.js rows (products:edit). Rows
 * carry only the columns the file had, so each one is written on its own
 * (a single upsert would need every row to have the same columns). A row with
 * an id updates that product; without one it is inserted.
 */
export async function upsertProducts(rows) {
  let created = 0;
  let updated = 0;
  for (const { id, ...row } of rows) {
    if (id) { unwrap(await supabase.from('products').update(row).eq('id', id)); updated += 1; }
    else { unwrap(await supabase.from('products').insert(row)); created += 1; }
  }
  return { created, updated };
}

/** Price lists: a % adjustment per city and / or sector, plus fixed prices per product. */
export async function listPriceLists() {
  return unwrap(await supabase.from('price_lists').select('*, cities(name), sectors(name)').order('name'));
}

export async function savePriceList(list) {
  const row = {
    name: list.name.trim(), city_id: list.city_id || null, sector_code: list.sector_code || null,
    adjustment_pct: Number(list.adjustment_pct) || 0, is_active: list.is_active !== false, note: list.note?.trim() || null,
  };
  const query = list.id
    ? supabase.from('price_lists').update(row).eq('id', list.id).select().single()
    : supabase.from('price_lists').insert(row).select().single();
  return unwrap(await query);
}

export async function deletePriceList(id) {
  unwrap(await supabase.from('price_lists').delete().eq('id', id));
}

export async function listPriceListItems(priceListId) {
  return unwrap(await supabase.from('price_list_items').select('*').eq('price_list_id', priceListId));
}

/** Fixed prices for products on one list: rows = [{ product_id, price, note? }]. Same product overwrites. */
export async function savePriceListItems(priceListId, rows) {
  if (!rows.length) return [];
  return unwrap(await supabase.from('price_list_items')
    .upsert(rows.map((r) => ({ price_list_id: priceListId, product_id: r.product_id, price: Number(r.price), note: r.note || null })), { onConflict: 'price_list_id,product_id' })
    .select());
}

export async function deletePriceListItem(priceListId, productId) {
  unwrap(await supabase.from('price_list_items').delete().eq('price_list_id', priceListId).eq('product_id', productId));
}

/** Customer side: [{ product_id, price }] for every product whose price for me differs from the published one. */
export async function getMyPriceList() {
  return unwrap(await supabase.rpc('my_price_list'));
}

/**
 * After packing: the actual quantity per line (orders:edit, order confirmed or packed).
 * lines = [{ order_item_id, packed_quantity }]. Returns { lines, subtotal, total_amount }.
 */
export async function setPackedQuantities(orderId, lines) {
  return unwrap(await supabase.rpc('set_packed_quantities', { p_order_id: orderId, p_items: lines }));
}

// ---------- Procurement (migration 011) --------------------------------------
// Rate cards, purchase orders, goods receipts and the buying list. Reads need
// procurement:view (receipts also inventory:view); POs need procurement:edit /
// approve; receiving needs inventory:edit. Scope applies throughout.

export async function listSupplierProducts({ supplierId, productId } = {}) {
  let query = supabase.from('supplier_products').select('*, suppliers(name), products(name, sku, unit)').order('price');
  if (supplierId) query = query.eq('supplier_id', supplierId);
  if (productId) query = query.eq('product_id', productId);
  return unwrap(await query);
}

/** One rate-card line (upsert on supplier + product). Only one preferred supplier per product (the database checks). */
export async function saveSupplierProduct(rate) {
  const n = (v) => (v === '' || v == null ? null : Number(v));
  const row = {
    supplier_id: rate.supplier_id, product_id: rate.product_id, price: Number(rate.price),
    moq: n(rate.moq) ?? 1, lead_days: n(rate.lead_days) ?? 1, is_preferred: Boolean(rate.is_preferred),
    valid_from: rate.valid_from || undefined, valid_to: rate.valid_to || null, note: rate.note?.trim() || null,
  };
  if (row.valid_from === undefined) delete row.valid_from;
  return unwrap(await supabase.from('supplier_products').upsert(row, { onConflict: 'supplier_id,product_id' }).select().single());
}

export async function deleteSupplierProduct(id) {
  unwrap(await supabase.from('supplier_products').delete().eq('id', id));
}

/** The buying list for one warehouse and delivery date; coverDays = how many days like that one to stock for. */
export async function getBuyingList(warehouseId, deliveryDate, coverDays = 1) {
  return unwrap(await supabase.rpc('buying_list', { p_warehouse_id: warehouseId, p_delivery_date: deliveryDate, p_cover_days: coverDays }));
}

const PO_SELECT = '*, suppliers(name, phone, contact), warehouses(name, address), purchase_order_items(*, products(name, sku, unit))';

/** filters: { status, warehouseId, supplierId, limit } */
export async function listPurchaseOrders({ status, warehouseId, supplierId, limit = 200 } = {}) {
  let query = supabase.from('purchase_orders').select(PO_SELECT).order('created_at', { ascending: false }).limit(limit);
  if (status) query = query.eq('status', status);
  if (warehouseId) query = query.eq('warehouse_id', warehouseId);
  if (supplierId) query = query.eq('supplier_id', supplierId);
  return unwrap(await query);
}

export async function getPurchaseOrder(id) {
  return unwrap(await supabase.from('purchase_orders').select(PO_SELECT).eq('id', id).maybeSingle());
}

/** items = [{ product_id, quantity, unit_cost? }] — a missing cost takes the supplier's rate card. Returns { id, po_number }. */
export async function createPurchaseOrder({ supplierId, warehouseId, expectedDate, notes, items }) {
  return unwrap(await supabase.rpc('create_purchase_order', {
    p_supplier_id: supplierId, p_warehouse_id: warehouseId, p_expected_date: expectedDate || null, p_notes: notes || null, p_items: items,
  }));
}

/** Replace the lines and details of a draft. */
export async function updatePurchaseOrder(id, { expectedDate, notes, items }) {
  unwrap(await supabase.rpc('update_purchase_order', { p_po_id: id, p_expected_date: expectedDate || null, p_notes: notes || null, p_items: items }));
}

/** 'sent' (approve, needs procurement:approve) · 'closed' (short-close) · 'cancelled' (nothing received). */
export async function setPurchaseOrderStatus(id, status) {
  unwrap(await supabase.rpc('set_purchase_order_status', { p_po_id: id, p_status: status }));
}

const GRN_SELECT = '*, suppliers(name), warehouses(name), purchase_orders(po_number), goods_receipt_items(*, products(name, sku, unit))';

/** filters: { warehouseId, poId, limit } */
export async function listGoodsReceipts({ warehouseId, poId, limit = 100 } = {}) {
  let query = supabase.from('goods_receipts').select(GRN_SELECT).order('created_at', { ascending: false }).limit(limit);
  if (warehouseId) query = query.eq('warehouse_id', warehouseId);
  if (poId) query = query.eq('po_id', poId);
  return unwrap(await query);
}

/**
 * Receive goods with a quality check (inventory:edit).
 * { warehouseId, supplierId, poId, source: 'po' | 'mandi' | 'direct', note, billPhotoPath, billAmount, paidCash,
 *   items: [{ product_id, qty_accepted, qty_rejected, unit_cost, grade, reject_reason, photo_path }] }
 * Returns { id, grn_number, po_status }.
 */
export async function receiveGoods({ warehouseId, supplierId, poId, source, items, note, billPhotoPath, billAmount, paidCash }) {
  return unwrap(await supabase.rpc('receive_goods', {
    p_warehouse_id: warehouseId || null, p_supplier_id: supplierId || null, p_po_id: poId || null, p_source: source,
    p_items: items, p_note: note || null, p_bill_photo_path: billPhotoPath || null,
    p_bill_amount: billAmount === '' || billAmount == null ? null : Number(billAmount), p_paid_cash: Boolean(paidCash),
  }));
}

/** Upload a bill / quality photo to the private purchase-bills bucket; returns its path. */
export async function uploadBillPhoto(file) {
  const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[file.type];
  if (!extension) throw new Error('Please choose a JPG, PNG or WebP image.');
  if (file.size > 8 * 1024 * 1024) throw new Error('Image is larger than 8 MB.');
  const path = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${extension}`;
  unwrap(await supabase.storage.from(config.billBucket).upload(path, file, { contentType: file.type }));
  return path;
}

/** A short-lived link to a bill photo (the bucket is private). */
export async function billPhotoUrl(path, seconds = 600) {
  if (!path) return null;
  return unwrap(await supabase.storage.from(config.billBucket).createSignedUrl(path, seconds)).signedUrl;
}

// ---------- Fulfilment & delivery (migration 012) ----------------------------

/** Active delivery accounts, for assigning a driver to a trip. */
export async function listDrivers() {
  return (await listUsers()).filter((u) => u.role === 'delivery' && u.is_active);
}

export async function listVehicles(cityId) {
  let query = supabase.from('vehicles').select('*').order('registration');
  if (cityId) query = query.eq('city_id', cityId);
  return unwrap(await query);
}
export async function saveVehicle(v) {
  const row = { city_id: v.city_id, registration: v.registration, label: v.label || null, capacity_note: v.capacity_note || null, is_active: v.is_active ?? true };
  if (v.id) return unwrap(await supabase.from('vehicles').update(row).eq('id', v.id));
  return unwrap(await supabase.from('vehicles').insert(row));
}

/** What to pick for a warehouse / date / (optional) slot — confirmed, not-yet-packed orders. */
export async function getPickList(warehouseId, deliveryDate, slot) {
  return unwrap(await supabase.rpc('pick_list', { p_warehouse_id: warehouseId, p_delivery_date: deliveryDate, p_slot: slot || null }));
}

/** Batches at or within `withinDays` of expiry (0 = already expired). */
export async function getExpiringBatches(warehouseId, withinDays = 3) {
  return unwrap(await supabase.rpc('expiring_batches', { p_warehouse_id: warehouseId, p_within_days: withinDays }));
}
/** Write off every expired batch in a warehouse; returns { batches, qty }. */
export async function writeOffExpired(warehouseId) {
  return unwrap(await supabase.rpc('write_off_expired', { p_warehouse_id: warehouseId }));
}

const TRIP_SELECT = '*, vehicles(registration, label), driver:profiles!trips_driver_id_fkey(full_name), '
  + 'trip_orders(stop_seq, orders(id, order_number, status, restaurant_name, delivery_address, contact_phone, total_amount, payment_method, payment_status, delivery_slot))';

/** filters: { status, warehouseId, driverId, date, limit } */
export async function listTrips({ status, warehouseId, driverId, date, limit = 100 } = {}) {
  let query = supabase.from('trips').select(TRIP_SELECT).order('created_at', { ascending: false }).limit(limit);
  if (status) query = query.eq('status', status);
  if (warehouseId) query = query.eq('warehouse_id', warehouseId);
  if (driverId) query = query.eq('driver_id', driverId);
  if (date) query = query.eq('trip_date', date);
  return unwrap(await query);
}
export async function getTrip(id) {
  return unwrap(await supabase.from('trips').select(TRIP_SELECT).eq('id', id).maybeSingle());
}
/** Returns { id, trip_number }. orderIds: packed/confirmed orders in one warehouse. */
export async function createTrip({ driverId, vehicleId, tripDate, slot, orderIds, notes }) {
  return unwrap(await supabase.rpc('create_trip', {
    p_driver_id: driverId || null, p_vehicle_id: vehicleId || null, p_trip_date: tripDate,
    p_slot: slot || null, p_order_ids: orderIds, p_notes: notes || null,
  }));
}
export async function updateTrip(id, { driverId, vehicleId, notes, orderIds }) {
  unwrap(await supabase.rpc('update_trip', { p_trip_id: id, p_driver_id: driverId || null, p_vehicle_id: vehicleId || null, p_notes: notes || null, p_order_ids: orderIds }));
}
/** Dispatch the trip: every packed order goes out for delivery with a POD OTP. Returns { dispatched }. */
export async function dispatchTrip(id) {
  return unwrap(await supabase.rpc('dispatch_trip', { p_trip_id: id }));
}
export async function setTripStatus(id, status) {
  unwrap(await supabase.rpc('set_trip_status', { p_trip_id: id, p_status: status }));
}

/**
 * Mark an out-for-delivery order delivered (the assigned driver, or fulfilment:edit staff).
 * returns: [{ order_item_id, qty, reason }] are doorstep refusals. Returns { total_amount, returned, cash_collected }.
 */
export async function completeDelivery(orderId, { otp, photoPath, note, returns = [] } = {}) {
  return unwrap(await supabase.rpc('complete_delivery', {
    p_order_id: orderId, p_otp: otp || null, p_photo_path: photoPath || null, p_note: note || null, p_returns: returns,
  }));
}

/** Per-driver cash collected vs settled. */
export async function getDriverCashSummary() {
  return unwrap(await supabase.rpc('driver_cash_summary'));
}
export async function settleDriverCash(driverId, amount, note) {
  unwrap(await supabase.rpc('settle_driver_cash', { p_driver_id: driverId, p_amount: Number(amount), p_note: note || null }));
}

export async function listDeliveryCharges() {
  return unwrap(await supabase.from('delivery_charge_rules').select('*, cities(name)').order('created_at', { ascending: false }));
}
export async function saveDeliveryCharge(r) {
  const row = { city_id: r.city_id || null, slot: r.slot || null, fee: Number(r.fee) || 0,
                free_above: r.free_above === '' || r.free_above == null ? null : Number(r.free_above),
                is_active: r.is_active ?? true, note: r.note || null };
  if (r.id) return unwrap(await supabase.from('delivery_charge_rules').update(row).eq('id', r.id));
  return unwrap(await supabase.from('delivery_charge_rules').insert(row));
}
export async function deleteDeliveryCharge(id) {
  unwrap(await supabase.from('delivery_charge_rules').delete().eq('id', id));
}

/** Upload a delivery photo to the private delivery-pod bucket; returns its path. */
export async function uploadPodPhoto(file) {
  const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[file.type];
  if (!extension) throw new Error('Please choose a JPG, PNG or WebP image.');
  if (file.size > 8 * 1024 * 1024) throw new Error('Image is larger than 8 MB.');
  const path = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${extension}`;
  unwrap(await supabase.storage.from(config.podBucket).upload(path, file, { contentType: file.type }));
  return path;
}
export async function podPhotoUrl(path, seconds = 600) {
  if (!path) return null;
  return unwrap(await supabase.storage.from(config.podBucket).createSignedUrl(path, seconds)).signedUrl;
}

// ---------- Trip pre-departure photo (migration 023) -------------------------

/** Upload the loading photo taken at the warehouse before leaving.
 *  Returns the storage path to pass to recordTripDeparture(). */
export async function uploadTripPhoto(file) {
  const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[file.type];
  if (!extension) throw new Error('Please choose a JPG, PNG or WebP image.');
  if (file.size > 10 * 1024 * 1024) throw new Error('Image is larger than 10 MB.');
  const path = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${extension}`;
  unwrap(await supabase.storage.from(config.tripPhotosBucket).upload(path, file, { contentType: file.type }));
  return path;
}

/** Persist the loading photo path on the trip row (calls record_trip_departure RPC). */
export async function recordTripDeparture(tripId, photoPath) {
  return unwrap(await supabase.rpc('record_trip_departure', {
    p_trip_id: tripId,
    p_photo_path: photoPath,
  }));
}

/** Signed URL for a trip loading photo (admin view). */
export async function tripPhotoUrl(path, seconds = 600) {
  if (!path) return null;
  return unwrap(await supabase.storage.from(config.tripPhotosBucket).createSignedUrl(path, seconds)).signedUrl;
}

// ---------- Orders + (migration 013) -----------------------------------------

/** Staff place an order for a customer (orders:edit). Same shape as placeOrder plus restaurantId. */
export async function placeOrderFor(restaurantId, items, { notes, deliveryDate, slot = 'morning', paymentMethod = 'cod', poReference, outletId } = {}) {
  return unwrap(await supabase.rpc('place_order_for', {
    p_restaurant_id: restaurantId, p_items: items, p_notes: notes || null,
    p_delivery_date: deliveryDate || null, p_delivery_slot: slot, p_payment_method: paymentMethod, p_po_reference: poReference || null,
    p_outlet_id: outletId || null,
  }));
}
/** Rebuild an order's lines before it is packed. Returns { total_amount, delivery_fee }. */
export async function editOrder(orderId, items, { notes, deliveryDate, slot, poReference } = {}) {
  return unwrap(await supabase.rpc('edit_order', {
    p_order_id: orderId, p_items: items, p_notes: notes ?? null,
    p_delivery_date: deliveryDate || null, p_delivery_slot: slot || null, p_po_reference: poReference ?? null,
  }));
}
/** Customer (before cut-off) or staff cancel; stock goes back. */
export async function cancelOrder(orderId, reason) {
  unwrap(await supabase.rpc('cancel_order', { p_order_id: orderId, p_reason: reason || null }));
}
/** Is a slot still open for a delivery date? { open, reason }. */
export async function slotOpen(cityId, date, slot) {
  return unwrap(await supabase.rpc('slot_open', { p_city_id: cityId, p_date: date, p_slot: slot }));
}

export async function reportIssue(orderId, kind, note) {
  return unwrap(await supabase.rpc('report_issue', { p_order_id: orderId, p_kind: kind, p_note: note || null }));
}
/** Support resolves an issue; creditAmount > 0 raises a credit note; reject closes with no credit. */
export async function resolveIssue(issueId, { resolution, creditAmount = 0, reject = false } = {}) {
  return unwrap(await supabase.rpc('resolve_issue', { p_issue_id: issueId, p_resolution: resolution || null, p_credit_amount: Number(creditAmount) || 0, p_reject: Boolean(reject) }));
}
const ISSUE_SELECT = '*, orders(order_number, delivery_date), restaurants(name)';
export async function listOrderIssues({ status, orderId, limit = 200 } = {}) {
  let query = supabase.from('order_issues').select(ISSUE_SELECT).order('created_at', { ascending: false }).limit(limit);
  if (status) query = query.eq('status', status);
  if (orderId) query = query.eq('order_id', orderId);
  return unwrap(await query);
}
export async function listCreditNotes({ restaurantId, limit = 200 } = {}) {
  let query = supabase.from('credit_notes').select('*, restaurants(name), orders(order_number)').order('created_at', { ascending: false }).limit(limit);
  if (restaurantId) query = query.eq('restaurant_id', restaurantId);
  return unwrap(await query);
}

export async function listSlotConfig() {
  return unwrap(await supabase.from('slot_config').select('*, cities(name)').order('slot'));
}
export async function saveSlotConfig(c) {
  const row = { city_id: c.city_id || null, slot: c.slot, cutoff_hour: Number(c.cutoff_hour),
                capacity_orders: c.capacity_orders === '' || c.capacity_orders == null ? null : Number(c.capacity_orders),
                is_active: c.is_active ?? true, note: c.note || null };
  if (c.id) return unwrap(await supabase.from('slot_config').update(row).eq('id', c.id));
  return unwrap(await supabase.from('slot_config').insert(row));
}
export async function deleteSlotConfig(id) {
  unwrap(await supabase.from('slot_config').delete().eq('id', id));
}

// ---------- Payments & credit (migration 015) --------------------------------
// Open-item receivables: a delivered order (or a debit note) is paid off by
// receipts and credit notes through allocations. Writes are functions needing
// payments:edit (void: payments:approve); reads need payments:view or
// customers:view in scope, and a customer may read their own.

/** Every customer in scope with a position: outstanding, overdue, ageing buckets, credit limit. payments:view. */
export async function getReceivablesSummary() {
  return unwrap(await supabase.rpc('receivables_summary'));
}

/** One customer: outstanding, overdue, credit limit / available, open items, unapplied receipts & credit notes. */
export async function getCustomerReceivables(restaurantId) {
  return unwrap(await supabase.rpc('customer_receivables', { p_restaurant_id: restaurantId }));
}

/** Statement between two dates (YYYY-MM-DD): opening balance, lines with running balance, closing balance. */
export async function getCustomerStatement(restaurantId, from, to) {
  return unwrap(await supabase.rpc('customer_statement', { p_restaurant_id: restaurantId, p_from: from, p_to: to }));
}

/**
 * Record a receipt. allocations = [{ order_id, amount }] / [{ debit_note_id, amount }] to apply
 * by hand; omit for oldest-due-first. Returns { id, receipt_number, amount, unallocated }.
 */
export async function recordPayment(restaurantId, { amount, method, reference, receivedOn, note, allocations }) {
  return unwrap(await supabase.rpc('record_payment', {
    p_restaurant_id: restaurantId, p_amount: Number(amount), p_method: method, p_reference: reference || null,
    p_received_on: receivedOn || null, p_note: note || null, p_allocations: allocations?.length ? allocations : null,
  }));
}

/** Apply (part of) an unapplied receipt to chosen open items. Returns { id, receipt_number, unallocated }. */
export async function allocatePayment(paymentId, allocations) {
  return unwrap(await supabase.rpc('allocate_payment', { p_payment_id: paymentId, p_allocations: allocations }));
}

/** Reverse a receipt (bounced cheque, mistake). payments:approve. Nothing is deleted. */
export async function voidPayment(paymentId, reason) {
  unwrap(await supabase.rpc('void_payment', { p_payment_id: paymentId, p_reason: reason }));
}

/** An extra charge to a customer. Returns { id, debit_note_number }. */
export async function raiseDebitNote(restaurantId, { amount, reason, orderId, dueDate }) {
  return unwrap(await supabase.rpc('raise_debit_note', {
    p_restaurant_id: restaurantId, p_amount: Number(amount), p_reason: reason, p_order_id: orderId || null, p_due_date: dueDate || null,
  }));
}

/** Receipts, newest first. filters: { restaurantId, limit }. RLS: own, or payments/customers:view in scope. */
export async function listPayments({ restaurantId, limit = 200 } = {}) {
  let query = supabase.from('payments').select('*, restaurants(name)').order('received_on', { ascending: false }).order('created_at', { ascending: false }).limit(limit);
  if (restaurantId) query = query.eq('restaurant_id', restaurantId);
  return unwrap(await query);
}

export async function listDebitNotes({ restaurantId, limit = 200 } = {}) {
  let query = supabase.from('debit_notes').select('*, restaurants(name), orders(order_number)').order('created_at', { ascending: false }).limit(limit);
  if (restaurantId) query = query.eq('restaurant_id', restaurantId);
  return unwrap(await query);
}

/** Which invoices / debit notes a receipt or credit note was applied to. */
export async function listPaymentAllocations({ paymentId, creditNoteId, orderId } = {}) {
  let query = supabase.from('payment_allocations').select('*, orders(order_number), debit_notes(debit_note_number)').order('created_at');
  if (paymentId) query = query.eq('payment_id', paymentId);
  if (creditNoteId) query = query.eq('credit_note_id', creditNoteId);
  if (orderId) query = query.eq('order_id', orderId);
  return unwrap(await query);
}

/**
 * Online payment (Razorpay). Step 1: the razorpay-order Edge Function creates a
 * gateway order for the signed-in customer and returns { order_id, amount, currency, key_id }.
 * Step 2 happens in the gateway's checkout; step 3 is the webhook (record_online_payment).
 */
export async function createOnlinePaymentOrder(amount) {
  const { data, error } = await supabase.functions.invoke('razorpay-order', { body: { amount: Number(amount) } });
  if (error) {
    let message = error.message;
    try { message = (await error.context?.json())?.error ?? message; } catch { /* keep default */ }
    throw new Error(message);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

// ---------- Notifications, support & help (migration 018) --------------------

// notification_settings has no id column: a row is identified by (event, sector_code), where a
// null sector is the default for every sector (two partial unique indexes, migration 018). The list
// adds `id` = "event|sector" so the screen can key its buttons; save/delete turn it back into filters.
const notifyKey = (event, sectorCode) => `${event}|${sectorCode ?? ''}`;
function whereNotifyKey(query, id) {
  const [event, sector] = String(id).split('|');
  query = query.eq('event', event);
  return sector ? query.eq('sector_code', sector) : query.is('sector_code', null);
}

/** Settings → Notifications: one row per event (sector_code null = default) plus per-sector overrides. Each row gets id = "event|sector". */
export async function listNotificationSettings() {
  const rows = unwrap(await supabase.from('notification_settings').select('*').order('event').order('sector_code', { nullsFirst: true }));
  return (rows ?? []).map((r) => ({ ...r, id: notifyKey(r.event, r.sector_code) }));
}

/** Insert or update one template row: { id?, event, sector_code, sms_enabled, email_enabled, sms_template, email_subject, email_template }. id (from the list) = existing row. */
export async function saveNotificationSetting(row) {
  const values = { event: row.event, sector_code: row.sector_code || null, sms_enabled: Boolean(row.sms_enabled), email_enabled: Boolean(row.email_enabled),
    sms_template: row.sms_template ?? '', email_subject: row.email_subject ?? '', email_template: row.email_template ?? '', updated_at: new Date().toISOString() };
  if (row.id) return unwrap(await whereNotifyKey(supabase.from('notification_settings').update(values), row.id).select().single());
  return unwrap(await supabase.from('notification_settings').insert(values).select().single());
}

/** Remove a sector override; `id` is the "event|sector" key from listNotificationSettings(). */
export async function deleteNotificationSetting(id) {
  unwrap(await whereNotifyKey(supabase.from('notification_settings').delete(), id));
}

/** The message log. Filters: { status, channel, restaurantId, orderId, limit }. RLS scopes rows. */
export async function listNotifications({ status, channel, restaurantId, orderId, limit = 200 } = {}) {
  let query = supabase.from('notifications').select('*, restaurants(name)').order('created_at', { ascending: false }).limit(limit);
  if (status) query = query.eq('status', status);
  if (channel) query = query.eq('channel', channel);
  if (restaurantId) query = query.eq('restaurant_id', restaurantId);
  if (orderId) query = query.eq('order_id', orderId);
  return unwrap(await query);
}

/** Re-queue a failed / skipped message (orders:edit or settings:edit). */
export async function retryNotification(id) {
  unwrap(await supabase.rpc('retry_notification', { p_id: id }));
}

/**
 * "Send now": runs the send-notifications Edge Function (queue reminders, then drain the outbox).
 * Returns { reminders_queued, claimed, sent, failed, skipped } or, with dryRun, the queue size and providers.
 */
export async function sendNotificationsNow({ limit = 50, dryRun = false } = {}) {
  const { data, error } = await supabase.functions.invoke('send-notifications', { body: { limit, dry_run: dryRun } });
  if (error) {
    let message = error.message;
    try { message = (await error.context?.json())?.error ?? message; } catch { /* keep default */ }
    throw new Error(message);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

/** Phone / WhatsApp / email we publish for support: { phone, whatsapp, email, name }. Public. */
export async function getSupportChannels() {
  return unwrap(await supabase.rpc('support_channels'));
}

// ----- Support tickets -----

/** Filters: { status, restaurantId, assignedTo, limit }. A customer sees only their own (RLS). */
export async function listTickets({ status, restaurantId, assignedTo, limit = 200 } = {}) {
  let query = supabase.from('support_tickets').select('*, restaurants(name, phone)').order('last_message_at', { ascending: false }).limit(limit);
  if (status) query = status === 'active' ? query.in('status', ['open', 'waiting_customer']) : query.eq('status', status);
  if (restaurantId) query = query.eq('restaurant_id', restaurantId);
  if (assignedTo) query = query.eq('assigned_to', assignedTo);
  return unwrap(await query);
}

export async function listTicketMessages(ticketId) {
  return unwrap(await supabase.from('ticket_messages').select('*, profiles:author_id(full_name)').eq('ticket_id', ticketId).order('created_at'));
}

/** Returns { id, ticket_number }. Staff pass restaurantId to open one on a customer's behalf. */
export async function openTicket({ subject, body, orderId, restaurantId, priority = 'normal' }) {
  return unwrap(await supabase.rpc('open_ticket', { p_subject: subject, p_body: body, p_order_id: orderId || null, p_restaurant_id: restaurantId || null, p_priority: priority }));
}

export async function replyTicket(ticketId, body) {
  unwrap(await supabase.rpc('reply_ticket', { p_ticket_id: ticketId, p_body: body }));
}

/** Staff: { status, assignedTo, priority } (any subset). A customer may only pass status 'closed'. */
export async function setTicket(ticketId, { status, assignedTo, priority } = {}) {
  unwrap(await supabase.rpc('set_ticket', { p_ticket_id: ticketId, p_status: status ?? null, p_assigned_to: assignedTo ?? null, p_priority: priority ?? null }));
}

// ----- Help centre -----

/** Published articles for the caller (RLS); admins also see drafts. `audience` narrows client-side. */
export async function listHelpArticles(audience) {
  const rows = unwrap(await supabase.from('help_articles').select('*').order('sort_order').order('title'));
  return audience ? rows.filter((a) => a.audience === audience || a.audience === 'all' || a.audience === 'public') : rows;
}

/** settings:edit. { id?, slug, title, body, audience, sort_order, is_published } */
export async function saveHelpArticle(a) {
  const values = { slug: a.slug, title: a.title, body: a.body, audience: a.audience, sort_order: Number(a.sort_order) || 0,
    is_published: Boolean(a.is_published), updated_at: new Date().toISOString() };
  if (a.id) return unwrap(await supabase.from('help_articles').update(values).eq('id', a.id).select().single());
  return unwrap(await supabase.from('help_articles').insert(values).select().single());
}

export async function deleteHelpArticle(id) {
  unwrap(await supabase.from('help_articles').delete().eq('id', id));
}

// ----- Map pin -----

/** Driver: { order_id: { lat, lng } } for the caller's active deliveries that have a pin (delivery_pins). */
export async function getDeliveryPins() {
  const rows = unwrap(await supabase.rpc('delivery_pins'));
  return Object.fromEntries((rows ?? []).map((r) => [r.order_id, { lat: r.lat, lng: r.lng }]));
}

/** The customer drops their own delivery pin (update_my_location). lat/lng null clears it. */
export async function updateMyLocation(lat, lng) {
  unwrap(await supabase.rpc('update_my_location', { p_lat: lat == null ? null : Number(lat), p_lng: lng == null ? null : Number(lng) }));
}

// ---------- Reports, documents, content pages (migration 019) ---------------------

/** sales_report(): rows { key, label, orders, quantity, subtotal, tax, delivery_fee, total, cancelled }. reports:view. */
export async function getSalesReport({ from, to, groupBy = 'day', cityId = null }) {
  return unwrap(await supabase.rpc('sales_report', { p_from: from, p_to: to, p_group_by: groupBy, p_city_id: cityId || null }));
}

/** receivables_trend(): one row per week { week_end, invoiced, collected, open, overdue }, oldest first. */
export async function getReceivablesTrend(weeks = 12, cityId = null) {
  return unwrap(await supabase.rpc('receivables_trend', { p_weeks: weeks, p_city_id: cityId || null }));
}

/**
 * Upload a customer document (FSSAI / GST) to <restaurantId>/<kind>.<ext> in the private bucket and record the
 * path (set_customer_document). The customer passes their own restaurant id; staff any in scope.
 */
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

/** Public pages. Anon sees published ones; admins also drafts. */
export async function listContentPages() {
  return unwrap(await supabase.from('content_pages').select('*').order('sort_order').order('title'));
}

export async function getContentPage(slug) {
  return unwrap(await supabase.from('content_pages').select('*').eq('slug', slug).maybeSingle());
}

/** settings:edit. { slug, title, body, is_published, show_in_footer, sort_order } — upsert on slug. */
export async function saveContentPage(page) {
  const values = { slug: page.slug, title: page.title, body: page.body, is_published: Boolean(page.is_published),
    show_in_footer: Boolean(page.show_in_footer), sort_order: Number(page.sort_order) || 0, updated_at: new Date().toISOString() };
  return unwrap(await supabase.from('content_pages').upsert(values, { onConflict: 'slug' }).select().single());
}

export async function deleteContentPage(slug) {
  unwrap(await supabase.from('content_pages').delete().eq('slug', slug));
}

// ---------- Customer organisation (migration 020) ------------------------------------

/** Outlets of the signed-in customer (RLS: own account) or, for staff, of one customer. */
export async function listOutlets(restaurantId) {
  let query = supabase.from('outlets').select('*').order('is_primary', { ascending: false }).order('name');
  if (restaurantId) query = query.eq('restaurant_id', restaurantId);
  return unwrap(await query);
}

/** Owner (own account) or staff (customers:edit): add / edit an outlet. Returns the outlet id. */
export async function saveOutlet({ id, restaurantId, name, address, phone, cityId, pincode, lat, lng, defaultSlot = 'morning', isActive = true, warehouseId }) {
  return unwrap(await supabase.rpc('save_outlet', {
    p_id: id || null, p_restaurant_id: restaurantId || null, p_name: name, p_address: address, p_phone: phone || null,
    p_city_id: cityId || null, p_pincode: pincode || null, p_lat: lat ?? null, p_lng: lng ?? null,
    p_default_slot: defaultSlot, p_is_active: isActive, p_warehouse_id: warehouseId || null,
  }));
}

/** Members of my account: [{ user_id, full_name, phone, role, outlet_id, outlet_name, is_active, created_at }]. */
export async function listMyCustomerUsers() {
  return unwrap(await supabase.rpc('my_customer_users'));
}

/** Staff: members of one customer account (customers:view). */
export async function listCustomerUsersOf(restaurantId) {
  return unwrap(await supabase.rpc('customer_users_of', { p_restaurant_id: restaurantId }));
}

/** Owner or staff: change a member's role / outlet / active flag (any subset). */
export async function setCustomerUser(userId, { role, outletId, isActive } = {}) {
  unwrap(await supabase.rpc('set_customer_user', { p_user_id: userId, p_role: role ?? null, p_outlet_id: outletId ?? null, p_is_active: isActive ?? null }));
}

/** Invite a member by email (customer-users Edge Function). role: 'outlet_manager' | 'approver'. */
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

/** Owner / approver: approve (true) or reject (false) an order held for approval. */
export async function approveOrder(orderId, approve, note) {
  unwrap(await supabase.rpc('approve_order', { p_order_id: orderId, p_approve: approve, p_note: note || null }));
}

// ---------- Ordering + (migration 021) --------------------------------------------------

/** Cart preview of a coupon: { valid, discount, reason, code, label }. */
export async function validateCoupon(code, subtotal) {
  return unwrap(await supabase.rpc('validate_coupon', { p_code: code, p_subtotal: Number(subtotal) || 0 }));
}

/** Settings → Coupons (admins read; settings:edit writes rows directly, RLS decides). */
export async function listCoupons() {
  return unwrap(await supabase.from('coupons').select('*').order('created_at', { ascending: false }));
}
export async function saveCoupon(c) {
  const values = { code: String(c.code).trim().toUpperCase(), description: c.description ?? '', kind: c.kind, value: Number(c.value),
    min_order_value: Number(c.min_order_value) || 0, max_discount: c.max_discount ? Number(c.max_discount) : null,
    valid_from: c.valid_from || undefined, valid_to: c.valid_to || null, sector_code: c.sector_code || null,
    once_per_customer: Boolean(c.once_per_customer), max_uses: c.max_uses ? Number(c.max_uses) : null, is_active: c.is_active !== false };
  if (c.id) return unwrap(await supabase.from('coupons').update(values).eq('id', c.id).select().single());
  return unwrap(await supabase.from('coupons').insert(values).select().single());
}
export async function listCouponRedemptions(couponId) {
  return unwrap(await supabase.from('coupon_redemptions').select('*, orders(order_number), restaurants(name)').eq('coupon_id', couponId).order('created_at', { ascending: false }));
}

/** Standing orders of my account (RLS) or, for staff, in scope (optionally one customer). */
export async function listStandingOrders(restaurantId) {
  let query = supabase.from('standing_orders').select('*, restaurants(name), outlets(name)').order('created_at', { ascending: false });
  if (restaurantId) query = query.eq('restaurant_id', restaurantId);
  return unwrap(await query);
}
/** items: [{product_id, quantity}], days: [0-6]. Returns the id. */
export async function saveStandingOrder({ id, name, items, days, slot = 'morning', paymentMethod = 'cod', outletId, poReference, notes, isActive = true }) {
  return unwrap(await supabase.rpc('save_standing_order', { p_id: id || null, p_name: name, p_items: items, p_days: days, p_slot: slot,
    p_payment_method: paymentMethod, p_outlet_id: outletId || null, p_po_reference: poReference || null, p_notes: notes || null, p_is_active: isActive }));
}
export async function setStandingOrderActive(id, active) {
  unwrap(await supabase.rpc('set_standing_order_active', { p_id: id, p_active: active }));
}

/** Quotes: the customer sees sent / accepted / declined ones; staff see every quote in scope. */
export async function listQuotes({ restaurantId, status } = {}) {
  let query = supabase.from('quotes').select('*, restaurants(name), outlets(name)').order('created_at', { ascending: false });
  if (restaurantId) query = query.eq('restaurant_id', restaurantId);
  if (status) query = query.eq('status', status);
  return unwrap(await query);
}
/** Staff: items [{product_id, quantity, unit_price}]. send = true sends it to the customer straight away. */
export async function saveQuote({ id, restaurantId, items, validUntil, notes, outletId, send = false }) {
  return unwrap(await supabase.rpc('save_quote', { p_id: id || null, p_restaurant_id: restaurantId, p_items: items, p_valid_until: validUntil, p_notes: notes || null, p_outlet_id: outletId || null, p_send: send }));
}
export async function setQuoteStatus(id, status) {
  unwrap(await supabase.rpc('set_quote_status', { p_id: id, p_status: status }));
}
/** Customer (owner / approver): accept into an order at the quoted prices. */
export async function acceptQuote(id, { deliveryDate, slot = 'morning', paymentMethod = 'cod', poReference } = {}) {
  return unwrap(await supabase.rpc('accept_quote', { p_id: id, p_delivery_date: deliveryDate || null, p_delivery_slot: slot, p_payment_method: paymentMethod, p_po_reference: poReference || null }));
}
export async function declineQuote(id, reason) {
  unwrap(await supabase.rpc('decline_quote', { p_id: id, p_reason: reason || null }));
}

/** Customer: own spend by month / product / outlet → [{ key, label, orders, quantity, total }]. */
export async function getMySpendReport({ from, to, groupBy = 'month' }) {
  return unwrap(await supabase.rpc('my_spend_report', { p_from: from, p_to: to, p_group_by: groupBy }));
}
