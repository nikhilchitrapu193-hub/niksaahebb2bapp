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

const ORDER_SELECT = '*, order_items(*)';

/** Filters are optional: { status, cityId, sectorCode }. RLS limits rows to the caller's scope. */
export async function listOrders({ status, cityId, sectorCode } = {}) {
  let query = supabase.from('orders').select(ORDER_SELECT).order('created_at', { ascending: false }).limit(200);
  if (status) query = query.eq('status', status);
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
export async function placeOrder(items, { notes, deliveryDate, slot = 'morning', paymentMethod = 'cod', poReference } = {}) {
  return unwrap(await supabase.rpc('place_order', {
    p_items: items,
    p_notes: notes || null,
    p_delivery_date: deliveryDate || null,
    p_delivery_slot: slot,
    p_payment_method: paymentMethod,
    p_po_reference: poReference || null,
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

export async function setOrderPayment(orderId, status) {
  unwrap(await supabase.rpc('set_order_payment', { p_order_id: orderId, p_status: status }));
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

/** Only the editable terms; code and name are fixed. */
export async function saveSectorTerms(code, terms) {
  unwrap(await supabase.from('sectors').update({
    min_order_value: Number(terms.min_order_value) || 0,
    delivery_fee_below_mov: Number(terms.delivery_fee_below_mov) || 0,
    credit_days: Number(terms.credit_days) || 0,
    needs_po_reference: Boolean(terms.needs_po_reference),
    needs_order_approval: Boolean(terms.needs_order_approval),
    can_self_register: Boolean(terms.can_self_register),
    is_active: terms.is_active ?? true,
  }).eq('code', code));
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
  };
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

export async function saveCategory(category) {
  const row = { name: category.name.trim(), sort_order: Number(category.sort_order) || 0 };
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

/** Goods received into one warehouse: lines = [{ product_id, quantity, unit_cost }]. */
export async function receiveStock(lines, supplierId, note, warehouseId) {
  unwrap(await supabase.rpc('receive_stock', {
    p_items: lines, p_supplier_id: supplierId || null, p_note: note || null, p_warehouse_id: warehouseId || null,
  }));
}

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
  }).eq('id', id));
}

/** Unpaid credit per restaurant: [{ restaurant_id, outstanding, unpaid_orders }]. */
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

export async function getDashboardStats() {
  return unwrap(await supabase.rpc('admin_dashboard_stats'));
}
