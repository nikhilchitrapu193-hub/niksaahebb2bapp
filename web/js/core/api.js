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

export async function listOrders({ status } = {}) {
  let query = supabase.from('orders').select(ORDER_SELECT).order('created_at', { ascending: false }).limit(200);
  if (status) query = query.eq('status', status);
  return unwrap(await query);
}

export async function getOrderHistory(orderId) {
  return unwrap(await supabase.from('order_status_history')
    .select('*').eq('order_id', orderId).order('created_at'));
}

/**
 * items: [{ product_id, quantity }]. Returns { id, order_number, total_amount }.
 * options: { notes, deliveryDate (YYYY-MM-DD), slot, paymentMethod }
 */
export async function placeOrder(items, { notes, deliveryDate, slot = 'morning', paymentMethod = 'cod' } = {}) {
  return unwrap(await supabase.rpc('place_order', {
    p_items: items,
    p_notes: notes || null,
    p_delivery_date: deliveryDate || null,
    p_delivery_slot: slot,
    p_payment_method: paymentMethod,
  }));
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

/** Goods received: lines = [{ product_id, quantity, unit_cost }]. */
export async function receiveStock(lines, supplierId, note) {
  unwrap(await supabase.rpc('receive_stock', { p_items: lines, p_supplier_id: supplierId || null, p_note: note || null }));
}

/** Set stock to an exact count. reason: 'adjustment' | 'wastage' | 'returned'. */
export async function adjustStock(productId, newQty, reason, note) {
  unwrap(await supabase.rpc('adjust_stock', { p_product_id: productId, p_new_qty: newQty, p_reason: reason, p_note: note || null }));
}

export async function listStockMovements(productId, limit = 50) {
  let query = supabase.from('stock_movements')
    .select('*, suppliers(name), orders(order_number)')
    .order('created_at', { ascending: false }).limit(limit);
  if (productId) query = query.eq('product_id', productId);
  return unwrap(await query);
}

// ---------- Admin: people ----------------------------------------------------

export async function listRestaurants() {
  return unwrap(await supabase.from('restaurants').select('*').order('created_at', { ascending: false }));
}

export async function setRestaurantStatus(id, status) {
  unwrap(await supabase.from('restaurants').update({ status }).eq('id', id));
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
export async function inviteStaff({ email, role, fullName }) {
  const { data, error } = await supabase.functions.invoke('invite-staff', {
    body: { email, role, full_name: fullName, redirect_to: `${webRoot}reset.html?role=${role}` },
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

export async function getDashboardStats() {
  return unwrap(await supabase.rpc('admin_dashboard_stats'));
}
