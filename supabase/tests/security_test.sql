-- =============================================================================
-- Security & business-rule regression test
--
-- HOW TO RUN: paste into the Supabase SQL Editor and click Run (or run with
-- psql). It creates throw-away users, impersonates each role, checks 308
-- rules (205 + 34 for launch control and payments & credit + 3 for customer access + 6 for the edit window + 15 for notifications & support + 15 for reports & dashboard + 15 for customer organisation + 15 for ordering +), then ABORTS ON PURPOSE so nothing is saved. The "error" you get back
-- is the report: every line should start with PASS.
--
-- Run this after ANY change to RLS policies or the functions in migrations.
-- Requires the seed catalogue (seed.sql: categories and products). The sample quotes,
-- benchmarks and stock in seed.sql are NOT needed; the test creates what it checks.
--
-- Roles simulated: admin (super admin), restaurant A (approved), restaurant B
-- (pending), delivery driver, a sign-up attempting to inject role=admin, and
-- from T20 on: a city manager of another city, a picker, and a defence unit;
-- from T30 on (migration 009): a pricing manager; from T40 on (migration 010): price lists and packing; from T44 on (migration 011): a buyer, POs and receipts; from T49 on (012/013): a dispatcher, trips, deliveries, slots, edits and credit notes;
-- from T57 on (014/015): the launch switches, receipts, allocation, credit limits, ageing and the webhook path.
-- =============================================================================

do $$
declare
  v_admin uuid := gen_random_uuid();
  v_ra    uuid := gen_random_uuid();
  v_rb    uuid := gen_random_uuid();
  v_del   uuid := gen_random_uuid();
  v_inj   uuid := gen_random_uuid();
  v_res   jsonb := '[]'::jsonb;
  v_p1 uuid; v_p2 uuid; v_p3 uuid;
  v_o1 jsonb; v_o2 jsonb;
  v_n int; v_num numeric; v_txt text; v_stats jsonb; v_stock1 numeric;
  -- Migration 006 (cities, sectors, roles, audit)
  v_city uuid; v_wh uuid; v_city2 uuid; v_wh2 uuid; v_cm uuid := gen_random_uuid(); v_pick uuid := gen_random_uuid();
  v_o3 jsonb; v_json jsonb;
  -- Migration 009 (pricing engine)
  v_pm uuid := gen_random_uuid(); v_sched bigint; v_src uuid;
  -- Migration 010 (catalogue +)
  v_leafy uuid; v_list uuid; v_o4 jsonb; v_item uuid; v_var uuid;
  -- Migration 011 (procurement)
  v_buyer uuid := gen_random_uuid(); v_sup uuid; v_sup2 uuid; v_po jsonb; v_grn jsonb; v_row jsonb; v_tomorrow date := (now() at time zone 'Asia/Kolkata')::date + 1;
  -- Migration 012 (fulfilment) and 013 (orders +)
  v_rc uuid := gen_random_uuid(); v_drv2 uuid := gen_random_uuid(); v_disp uuid := gen_random_uuid();
  v_trip jsonb; v_veh uuid; v_otp text; v_iss jsonb; v_oc jsonb; v_od jsonb; v_oe jsonb; v_of jsonb; v_ddate date; v_later date := (now() at time zone 'Asia/Kolkata')::date + 3;
  -- Migration 014 (launch control) and 015 (payments & credit)
  v_rcid uuid; v_og jsonb; v_oh jsonb; v_pay jsonb; v_bal jsonb; v_stockc numeric; v_today date := (now() at time zone 'Asia/Kolkata')::date;
  -- Migration 020 (customer organisation)
  v_mgr uuid := gen_random_uuid(); v_appr uuid := gen_random_uuid(); v_out2 uuid; v_oi jsonb; v_oj jsonb;
  -- Migration 021 (ordering +)
  v_coupon uuid; v_so uuid; v_quote jsonb; v_ok jsonb; v_ol jsonb;
begin
  select id into v_city from public.cities where name = 'Visakhapatnam';
  select id into v_wh from public.warehouses where city_id = v_city and is_default;
  -- Pin code 530001 is served by the Vizag warehouse (seed.sql adds it too); sign-ups below use it.
  insert into public.service_zones (warehouse_id, pincode, area_name) values (v_wh, '530001', 'Test area')
  on conflict (pincode) do nothing;
  -- Clear any seeded slot cut-offs / delivery-charge rules so the order totals below are
  -- deterministic regardless of the wall clock (the slot tests, T53, add their own).
  delete from public.slot_config;
  delete from public.delivery_charge_rules;

  select id into v_p1 from public.products where sku = 'VEG-001';  -- Tomato, 32, min 5
  select id into v_p2 from public.products where sku = 'DAI-002';  -- Paneer, 340, min 2
  select id into v_p3 from public.products where sku = 'VEG-005';  -- Coriander (made out of stock)

  insert into auth.users (id, aud, role, email, email_confirmed_at, raw_user_meta_data, created_at, updated_at) values
    (v_admin, 'authenticated', 'authenticated', 'admin@test.local', now(), '{}'::jsonb, now(), now()),
    (v_ra,    'authenticated', 'authenticated', 'ra@test.local',    now(), '{"restaurant_name":"Test Kitchen A","address":"12 Road, Hyderabad","phone":"9000000001","full_name":"Owner A","pincode":"530001"}'::jsonb, now(), now()),
    (v_rb,    'authenticated', 'authenticated', 'rb@test.local',    now(), '{"restaurant_name":"Test Kitchen B","address":"34 Lane, Hyderabad","pincode":"530001"}'::jsonb, now(), now()),
    (v_del,   'authenticated', 'authenticated', 'del@test.local',   now(), '{}'::jsonb, now(), now()),
    (v_inj,   'authenticated', 'authenticated', 'inj@test.local',   now(), '{"role":"admin","restaurant_name":"Evil"}'::jsonb, now(), now());

  update public.profiles    set role = 'admin'    where id = v_admin;
  update public.profiles    set role = 'delivery' where id = v_del;
  update public.restaurants set status = 'approved' where owner_id = v_ra;
  update public.products    set in_stock = false  where id = v_p3;
  select stock_qty into v_stock1 from public.products where id = v_p1;

  -- T1 role injection via sign-up metadata
  select role::text into v_txt from public.profiles where id = v_inj;
  v_res := v_res || jsonb_build_array(case when v_txt = 'restaurant' then 'PASS T1 sign-up cannot self-assign admin role' else 'FAIL T1 injected role = ' || v_txt end);

  -- T2 anonymous visitor: public catalogue only, nothing else
  perform set_config('request.jwt.claims', '{}', true);
  set local role anon;
  select count(*) into v_n from public.products;
  v_res := v_res || jsonb_build_array(case when v_n = 26 then 'PASS T2a anonymous visitors can browse the public catalogue (25 products + the 25 kg rice variant)' else 'FAIL T2a anon sees ' || v_n end);
  begin
    perform 1 from public.orders limit 1;
    v_res := v_res || jsonb_build_array('FAIL T2b anon can read orders');
  exception when insufficient_privilege then
    v_res := v_res || jsonb_build_array('PASS T2b anonymous visitors blocked from orders');
  end;
  begin
    perform 1 from public.restaurants limit 1;
    v_res := v_res || jsonb_build_array('FAIL T2c anon can read restaurants');
  exception when insufficient_privilege then
    v_res := v_res || jsonb_build_array('PASS T2c anonymous visitors blocked from restaurants');
  end;
  begin
    perform 1 from public.suppliers limit 1;
    v_res := v_res || jsonb_build_array('FAIL T2d anon can read suppliers');
  exception when insufficient_privilege then
    v_res := v_res || jsonb_build_array('PASS T2d anonymous visitors blocked from suppliers (migration 007)');
  end;
  begin
    perform 1 from public.pricing_rules limit 1;
    v_res := v_res || jsonb_build_array('FAIL T2e anon can read pricing rules');
  exception when insufficient_privilege then
    v_res := v_res || jsonb_build_array('PASS T2e anonymous visitors blocked from pricing rules (migration 009)');
  end;
  reset role;

  -- T3 pending restaurant B: can browse, cannot order
  perform set_config('request.jwt.claims', json_build_object('sub', v_rb, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.products;
  v_res := v_res || jsonb_build_array(case when v_n = 26 then 'PASS T3a pending restaurant can browse 26 products' else 'FAIL T3a sees ' || v_n end);
  begin
    perform public.place_order(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 10)));
    v_res := v_res || jsonb_build_array('FAIL T3b pending restaurant placed an order');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T3b pending restaurant blocked: ' || sqlerrm);
  end;
  reset role;

  -- T4 approved restaurant A: server-side pricing + duplicate merge
  perform set_config('request.jwt.claims', json_build_object('sub', v_ra, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_o1 := public.place_order(jsonb_build_array(
            jsonb_build_object('product_id', v_p1, 'quantity', 10, 'price', 1),
            jsonb_build_object('product_id', v_p2, 'quantity', 2),
            jsonb_build_object('product_id', v_p1, 'quantity', 5)), 'test note');
  v_res := v_res || jsonb_build_array(case when (v_o1 ->> 'total_amount')::numeric = 1293 then 'PASS T4a total 1293 = 15x32 + 2x340 + 5% GST on paneer + 99 delivery fee below MOV (client price ignored, duplicates merged)' else 'FAIL T4a total ' || (v_o1 ->> 'total_amount') end);
  select stock_qty into v_num from public.products where id = v_p1;
  v_res := v_res || jsonb_build_array(case when v_num = v_stock1 - 15 then 'PASS T4c stock reserved: tomato ' || v_stock1 || ' -> ' || v_num else 'FAIL T4c tomato stock ' || v_num end);
  select count(*) into v_n from public.order_items where order_id = (v_o1 ->> 'id')::uuid;
  v_res := v_res || jsonb_build_array(case when v_n = 2 then 'PASS T4b 2 merged line items stored' else 'FAIL T4b lines ' || v_n end);

  -- T5 minimum quantity
  begin
    perform public.place_order(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 1)));
    v_res := v_res || jsonb_build_array('FAIL T5 below-minimum quantity accepted');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T5 below minimum rejected: ' || sqlerrm);
  end;

  -- T6 out of stock
  begin
    perform public.place_order(jsonb_build_array(jsonb_build_object('product_id', v_p3, 'quantity', 5)));
    v_res := v_res || jsonb_build_array('FAIL T6 out-of-stock item accepted');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T6 out of stock rejected: ' || sqlerrm);
  end;

  -- T6b more than warehouse stock
  begin
    perform public.place_order(jsonb_build_array(jsonb_build_object('product_id', v_p2, 'quantity', 9999)));
    v_res := v_res || jsonb_build_array('FAIL T6b oversold beyond stock');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T6b cannot order more than stock: ' || sqlerrm);
  end;

  -- T6c delivery date rules
  begin
    perform public.place_order(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 5)), null, current_date - 1, 'morning', 'cod');
    v_res := v_res || jsonb_build_array('FAIL T6c past delivery date accepted');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T6c past delivery date rejected');
  end;

  -- T6d stock functions are admin-only
  begin
    perform public.receive_stock(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 100)));
    v_res := v_res || jsonb_build_array('FAIL T6d restaurant received stock');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T6d restaurant cannot receive stock');
  end;
  begin
    perform 1 from public.stock_movements limit 1;
    select count(*) into v_n from public.stock_movements;
    v_res := v_res || jsonb_build_array(case when v_n = 0 then 'PASS T6e restaurant sees no stock ledger' else 'FAIL T6e sees ' || v_n end);
  exception when insufficient_privilege then
    v_res := v_res || jsonb_build_array('PASS T6e restaurant blocked from stock ledger');
  end;

  -- T8 direct writes blocked
  begin
    insert into public.orders (restaurant_id, placed_by, restaurant_name, delivery_address) values (gen_random_uuid(), v_ra, 'x', 'y');
    v_res := v_res || jsonb_build_array('FAIL T8a direct insert into orders allowed');
  exception when insufficient_privilege then
    v_res := v_res || jsonb_build_array('PASS T8a direct insert into orders blocked');
  end;
  update public.products set price = 1 where id = v_p1;
  get diagnostics v_n = row_count;
  v_res := v_res || jsonb_build_array(case when v_n = 0 then 'PASS T8b restaurant cannot edit product prices' else 'FAIL T8b updated ' || v_n || ' product rows' end);

  -- T9 / T11 admin-only functions
  begin
    perform public.admin_dashboard_stats();
    v_res := v_res || jsonb_build_array('FAIL T9 restaurant read admin stats');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T9 restaurant blocked from admin stats');
  end;
  begin
    perform public.admin_set_user_role(v_rb, 'admin', true);
    v_res := v_res || jsonb_build_array('FAIL T11 restaurant changed a role');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T11 restaurant blocked from changing roles');
  end;

  -- T10 restaurant status rules
  begin
    perform public.set_order_status((v_o1 ->> 'id')::uuid, 'confirmed');
    v_res := v_res || jsonb_build_array('FAIL T10a restaurant confirmed its own order');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T10a restaurant cannot confirm orders');
  end;
  v_o2 := public.place_order(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 5)));
  perform public.set_order_status((v_o2 ->> 'id')::uuid, 'cancelled', 'changed my mind');
  select status::text into v_txt from public.orders where id = (v_o2 ->> 'id')::uuid;
  v_res := v_res || jsonb_build_array(case when v_txt = 'cancelled' then 'PASS T10b restaurant can cancel its own placed order' else 'FAIL T10b status ' || v_txt end);
  select stock_qty into v_num from public.products where id = v_p1;
  v_res := v_res || jsonb_build_array(case when v_num = v_stock1 - 15 then 'PASS T10c cancelled order returned its 5 units to stock' else 'FAIL T10c tomato stock ' || v_num end);
  reset role;

  -- T7 isolation: B sees none of A's orders
  perform set_config('request.jwt.claims', json_build_object('sub', v_rb, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.orders;
  v_res := v_res || jsonb_build_array(case when v_n = 0 then 'PASS T7 restaurant B sees 0 of restaurant A orders' else 'FAIL T7 B sees ' || v_n end);
  reset role;

  -- T12 admin workflow
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.orders;
  v_res := v_res || jsonb_build_array(case when v_n = 2 then 'PASS T12a admin sees all 2 orders' else 'FAIL T12a admin sees ' || v_n end);
  select count(*) into v_n from public.admin_list_users();
  v_res := v_res || jsonb_build_array(case when v_n >= 5 then 'PASS T12b admin can list users with emails (' || v_n || ')' else 'FAIL T12b users ' || v_n end);
  perform public.set_order_status((v_o1 ->> 'id')::uuid, 'confirmed');
  begin
    perform public.set_order_status((v_o1 ->> 'id')::uuid, 'delivered');
    v_res := v_res || jsonb_build_array('FAIL T12c admin skipped steps');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T12c cannot skip from confirmed to delivered');
  end;
  perform public.set_order_status((v_o1 ->> 'id')::uuid, 'packed');
  begin
    perform public.set_order_status((v_o1 ->> 'id')::uuid, 'out_for_delivery');
    v_res := v_res || jsonb_build_array('FAIL T12d dispatched with no driver');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T12d dispatch blocked until driver assigned');
  end;
  begin
    perform public.assign_delivery((v_o1 ->> 'id')::uuid, v_ra);
    v_res := v_res || jsonb_build_array('FAIL T12e assigned a restaurant as driver');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T12e only delivery accounts can be assigned');
  end;
  perform public.assign_delivery((v_o1 ->> 'id')::uuid, v_del);
  perform public.set_order_status((v_o1 ->> 'id')::uuid, 'out_for_delivery');
  begin
    perform public.admin_set_user_role(v_admin, 'delivery', true);
    v_res := v_res || jsonb_build_array('FAIL T12f admin demoted self');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T12f admin cannot demote themselves');
  end;
  perform public.set_customer_status((select id from public.restaurants where owner_id = v_rb), 'approved');
  select status::text into v_txt from public.restaurants where owner_id = v_rb;
  v_res := v_res || jsonb_build_array(case when v_txt = 'approved' then 'PASS T12g admin can approve restaurants' else 'FAIL T12g status ' || v_txt end);
  perform public.receive_stock(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 50, 'unit_cost', 20)), null, 'GRN test');
  select stock_qty into v_num from public.products where id = v_p1;
  v_res := v_res || jsonb_build_array(case when v_num = v_stock1 + 35 then 'PASS T12h receive_stock added 50 (now ' || v_num || ')' else 'FAIL T12h stock ' || v_num end);
  perform public.adjust_stock(v_p1, v_stock1, 'wastage', '5 kg spoiled');
  select stock_qty into v_num from public.products where id = v_p1;
  v_res := v_res || jsonb_build_array(case when v_num = v_stock1 then 'PASS T12i adjust_stock set exact count' else 'FAIL T12i stock ' || v_num end);
  select count(*) into v_n from public.stock_movements where product_id = v_p1;
  v_res := v_res || jsonb_build_array(case when v_n = 5 then 'PASS T12j ledger has 5 movements (order, order, cancel, receive, wastage)' else 'FAIL T12j ledger rows ' || v_n end);
  begin
    perform public.adjust_stock(v_p1, -1);
    v_res := v_res || jsonb_build_array('FAIL T12k negative stock accepted');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T12k negative stock rejected');
  end;
  -- Migration 015: "mark paid" became a receipt. The order is still out for delivery, so the
  -- cash stays unapplied (an advance) until an open item exists; the order itself is not paid yet.
  v_json := public.record_payment((select id from public.restaurants where owner_id = v_ra), 1293, 'cash', null, null, 'advance for ' || (v_o1 ->> 'order_number'));
  select payment_status::text into v_txt from public.orders where id = (v_o1 ->> 'id')::uuid;
  v_res := v_res || jsonb_build_array(case when (v_json ->> 'receipt_number') like 'RCT-%' and (v_json ->> 'unallocated')::numeric = 1293 and v_txt = 'unpaid'
    then 'PASS T12l admin records a cash receipt ' || (v_json ->> 'receipt_number') || '; an undelivered order is not an open item, so it stays unapplied' else 'FAIL T12l ' || v_json::text || ' ' || v_txt end);
  update public.company_settings set gstin = '36TEST0000A1Z5';
  get diagnostics v_n = row_count;
  v_res := v_res || jsonb_build_array(case when v_n = 1 then 'PASS T12m admin can edit company settings' else 'FAIL T12m rows ' || v_n end);
  reset role;

  -- T13 delivery person
  perform set_config('request.jwt.claims', json_build_object('sub', v_del, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.orders;
  v_res := v_res || jsonb_build_array(case when v_n = 1 then 'PASS T13a driver sees only the 1 assigned order' else 'FAIL T13a driver sees ' || v_n end);
  begin
    perform public.set_order_status((v_o1 ->> 'id')::uuid, 'cancelled');
    v_res := v_res || jsonb_build_array('FAIL T13b driver cancelled an order');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T13b driver cannot cancel');
  end;
  begin
    perform public.place_order(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 10)));
    v_res := v_res || jsonb_build_array('FAIL T13c driver placed an order');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T13c driver cannot place orders');
  end;
  perform public.set_order_status((v_o1 ->> 'id')::uuid, 'delivered', 'handed to chef');
  v_res := v_res || jsonb_build_array('PASS T13d driver marked delivered');
  reset role;

  -- T14 restaurant cannot cancel after dispatch
  perform set_config('request.jwt.claims', json_build_object('sub', v_ra, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.set_order_status((v_o1 ->> 'id')::uuid, 'cancelled');
    v_res := v_res || jsonb_build_array('FAIL T14 cancelled a delivered order');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T14 cannot cancel after delivery');
  end;
  reset role;

  -- T15 / T16 audit trail and dashboard
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.order_status_history where order_id = (v_o1 ->> 'id')::uuid;
  v_res := v_res || jsonb_build_array(case when v_n = 5 then 'PASS T15 audit trail has 5 entries' else 'FAIL T15 history rows ' || v_n end);
  v_stats := public.admin_dashboard_stats();
  v_res := v_res || jsonb_build_array(case when (v_stats ->> 'revenue_today')::numeric = 1293 and (v_stats ->> 'orders_today')::int = 2
                                           then 'PASS T16 dashboard: 2 orders today, revenue 1293 (cancelled excluded)'
                                           else 'FAIL T16 stats ' || v_stats::text end);
  reset role;

  -- T17 deactivated account is locked out
  update public.profiles set is_active = false where id = v_ra;
  perform set_config('request.jwt.claims', json_build_object('sub', v_ra, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.products;
  v_res := v_res || jsonb_build_array(case when v_n = 0 then 'PASS T17 deactivated user sees nothing' else 'FAIL T17 sees ' || v_n end);
  reset role;

  -- T19 first-admin bootstrap is one-shot
  perform set_config('request.jwt.claims', json_build_object('sub', v_rb, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_res := v_res || jsonb_build_array(case when public.claim_first_admin() = false then 'PASS T19 claim_first_admin refused: an admin already exists' else 'FAIL T19 second admin claimed' end);
  reset role;

  -- T18 price integrity
  select price into v_num from public.products where id = v_p1;
  v_res := v_res || jsonb_build_array(case when v_num = 32 then 'PASS T18 product price unchanged at 32' else 'FAIL T18 price ' || v_num end);


  -- ===========================================================================
  -- Migration 006: cities, warehouses, sectors, permission matrix, scope, audit
  -- ===========================================================================

  -- T20 customers and drivers cannot see internal tables
  perform set_config('request.jwt.claims', json_build_object('sub', v_rb, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.audit_log;
  v_res := v_res || jsonb_build_array(case when v_n = 0 then 'PASS T20a customer sees no audit log' else 'FAIL T20a sees ' || v_n end);
  select count(*) into v_n from public.role_permissions;
  v_res := v_res || jsonb_build_array(case when v_n = 0 then 'PASS T20b customer sees no permission matrix' else 'FAIL T20b sees ' || v_n end);
  select count(*) into v_n from public.warehouse_stock;
  v_res := v_res || jsonb_build_array(case when v_n = 0 then 'PASS T20c customer sees no warehouse stock' else 'FAIL T20c sees ' || v_n end);
  select count(*) into v_n from public.service_zones;
  v_res := v_res || jsonb_build_array(case when v_n = 0 then 'PASS T20d customer sees no service zones' else 'FAIL T20d sees ' || v_n end);
  v_json := public.my_order_terms();
  v_res := v_res || jsonb_build_array(case when (v_json ->> 'min_order_value')::numeric = 2000 and (v_json ->> 'delivers')::boolean then 'PASS T20e my_order_terms gives sector MOV 2000 and delivers=true' else 'FAIL T20e ' || v_json::text end);
  reset role;

  -- T21 logged-out website: cities, sectors and the pin-code check only
  perform set_config('request.jwt.claims', '{}', true);
  set local role anon;
  select count(*) into v_n from public.cities;
  v_res := v_res || jsonb_build_array(case when v_n >= 1 then 'PASS T21a anonymous can read cities' else 'FAIL T21a cities ' || v_n end);
  select count(*) into v_n from public.sectors where can_self_register;
  v_res := v_res || jsonb_build_array(case when v_n = (select count(*) from public.sectors where is_active) and v_n >= 5 then 'PASS T21b anonymous sees all ' || v_n || ' sectors on the sign-up form (migration 008)' else 'FAIL T21b ' || v_n end);
  v_json := public.check_pincode('530001');
  v_res := v_res || jsonb_build_array(case when (v_json ->> 'delivers')::boolean and v_json ->> 'city' = 'Visakhapatnam' then 'PASS T21c check_pincode(530001) = Visakhapatnam' else 'FAIL T21c ' || v_json::text end);
  v_json := public.check_pincode('999999');
  v_res := v_res || jsonb_build_array(case when not (v_json ->> 'delivers')::boolean then 'PASS T21d check_pincode(999999) = not served' else 'FAIL T21d ' || v_json::text end);
  begin
    perform 1 from public.audit_log limit 1;
    v_res := v_res || jsonb_build_array('FAIL T21e anon can read audit log');
  exception when insufficient_privilege then
    v_res := v_res || jsonb_build_array('PASS T21e anonymous blocked from audit log');
  end;
  begin
    perform 1 from public.warehouses limit 1;
    v_res := v_res || jsonb_build_array('FAIL T21f anon can read warehouses');
  exception when insufficient_privilege then
    v_res := v_res || jsonb_build_array('PASS T21f anonymous blocked from warehouses');
  end;
  reset role;

  -- T22 defence sector: purchase-order number required
  update public.restaurants set sector_code = 'defence' where owner_id = v_rb;   -- B is approved (T12g)
  perform set_config('request.jwt.claims', json_build_object('sub', v_rb, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.place_order(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 10)));
    v_res := v_res || jsonb_build_array('FAIL T22a defence order accepted without PO');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T22a defence order needs a PO: ' || sqlerrm);
  end;
  v_o3 := public.place_order(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 10)), null, null, 'morning', 'credit', 'PO/2026/0042');
  select po_reference || ' / ' || sector_code into v_txt from public.orders where id = (v_o3 ->> 'id')::uuid;
  v_res := v_res || jsonb_build_array(case when v_txt = 'PO/2026/0042 / defence' then 'PASS T22b PO number and sector snapshotted on the order' else 'FAIL T22b ' || coalesce(v_txt, 'null') end);
  v_res := v_res || jsonb_build_array(case when (v_o3 ->> 'delivery_fee')::numeric = 0 then 'PASS T22c defence sector has no MOV, so no delivery fee' else 'FAIL T22c fee ' || (v_o3 ->> 'delivery_fee') end);
  reset role;

  -- T23 minimum order value with no fee = order refused (per-customer override)
  update public.restaurants set min_order_value = 100000, delivery_fee_below_mov = 0 where owner_id = v_rb;
  perform set_config('request.jwt.claims', json_build_object('sub', v_rb, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.place_order(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 10)), null, null, 'morning', 'cod', 'PO/1');
    v_res := v_res || jsonb_build_array('FAIL T23 order below MOV accepted');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T23 below MOV with no fee refused: ' || sqlerrm);
  end;
  reset role;
  update public.restaurants set min_order_value = null, delivery_fee_below_mov = null where owner_id = v_rb;

  -- T24 a city manager of ANOTHER city sees nothing of Vizag
  insert into public.cities (name) values ('Hyderabad') returning id into v_city2;
  insert into public.warehouses (city_id, name, is_default) values (v_city2, 'Hyd warehouse', true) returning id into v_wh2;
  insert into auth.users (id, aud, role, email, email_confirmed_at, raw_user_meta_data, created_at, updated_at) values
    (v_cm,   'authenticated', 'authenticated', 'cm@test.local',   now(), '{}'::jsonb, now(), now()),
    (v_pick, 'authenticated', 'authenticated', 'pick@test.local', now(), '{}'::jsonb, now(), now());
  update public.profiles set role = 'admin', team_role = 'city_manager', city_id = v_city2 where id = v_cm;
  update public.profiles set role = 'admin', team_role = 'picker' where id = v_pick;
  perform set_config('request.jwt.claims', json_build_object('sub', v_cm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.orders;
  v_res := v_res || jsonb_build_array(case when v_n = 0 then 'PASS T24a Hyderabad city manager sees 0 Vizag orders' else 'FAIL T24a sees ' || v_n end);
  select count(*) into v_n from public.restaurants;
  v_res := v_res || jsonb_build_array(case when v_n = 0 then 'PASS T24b Hyderabad city manager sees 0 Vizag customers' else 'FAIL T24b sees ' || v_n end);
  begin
    perform public.receive_stock(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 10)), null, null, v_wh);
    v_res := v_res || jsonb_build_array('FAIL T24c received stock into a warehouse outside scope');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T24c cannot receive stock outside own city: ' || sqlerrm);
  end;
  perform public.receive_stock(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 10)), null, 'Hyd GRN');
  select qty into v_num from public.warehouse_stock where warehouse_id = v_wh2 and product_id = v_p1;
  v_res := v_res || jsonb_build_array(case when v_num = 10 then 'PASS T24d city manager received 10 into own default warehouse' else 'FAIL T24d qty ' || coalesce(v_num::text, 'null') end);
  begin
    perform public.set_order_status((v_o3 ->> 'id')::uuid, 'confirmed');
    v_res := v_res || jsonb_build_array('FAIL T24e confirmed an order in another city');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T24e cannot move orders of another city');
  end;
  begin
    perform public.admin_set_team_member(v_pick, 'admin', true, 'super_admin');
    v_res := v_res || jsonb_build_array('FAIL T24f city manager granted super admin');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T24f only a super admin can grant super admin');
  end;
  begin
    insert into public.role_permissions values ('city_manager', 'team', 'edit');
    v_res := v_res || jsonb_build_array('FAIL T24g city manager edited the permission matrix');
  exception when insufficient_privilege then
    v_res := v_res || jsonb_build_array('PASS T24g only a super admin can change the permission matrix');
  end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.admin_set_team_member(v_pick, 'admin', true, null);
    v_res := v_res || jsonb_build_array('FAIL T24i staff saved without a team role');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T24i staff must have a team role: ' || sqlerrm);
  end;
  perform public.admin_set_team_member(v_pick, 'admin', true, 'picker', v_city, v_wh);
  v_res := v_res || jsonb_build_array(case when (select city_id from public.profiles where id = v_pick) = v_city then 'PASS T24j super admin set picker scope to Vizag' else 'FAIL T24j scope not saved' end);
  reset role;
  select stock_qty into v_num from public.products where id = v_p1;
  v_res := v_res || jsonb_build_array(case when v_num = v_stock1 - 10 + 10 then 'PASS T24h product total = Vizag stock + Hyderabad stock' else 'FAIL T24h total ' || v_num end);

  -- T25 a picker (orders view/edit only)
  perform set_config('request.jwt.claims', json_build_object('sub', v_pick, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.set_order_status((v_o3 ->> 'id')::uuid, 'confirmed');
  select status::text into v_txt from public.orders where id = (v_o3 ->> 'id')::uuid;
  v_res := v_res || jsonb_build_array(case when v_txt = 'confirmed' then 'PASS T25a picker can move an order (orders:edit)' else 'FAIL T25a status ' || v_txt end);
  begin
    perform public.record_payment((select restaurant_id from public.orders where id = (v_o3 ->> 'id')::uuid), 100, 'cash');
    v_res := v_res || jsonb_build_array('FAIL T25b picker recorded a payment');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T25b picker cannot record payments (payments:edit)');
  end;
  begin
    perform public.admin_list_users();
    v_res := v_res || jsonb_build_array('FAIL T25c picker listed the team');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T25c picker cannot list the team (team:view)');
  end;
  select count(*) into v_n from public.audit_log;
  v_res := v_res || jsonb_build_array(case when v_n = 0 then 'PASS T25d picker sees no audit log (audit:view)' else 'FAIL T25d sees ' || v_n end);
  update public.products set price = 1 where id = v_p1;
  get diagnostics v_n = row_count;
  v_res := v_res || jsonb_build_array(case when v_n = 0 then 'PASS T25e picker cannot edit prices (products:edit)' else 'FAIL T25e updated ' || v_n end);
  begin
    perform public.set_customer_status((select id from public.restaurants where owner_id = v_rb), 'suspended');
    v_res := v_res || jsonb_build_array('FAIL T25f picker suspended a customer');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T25f picker cannot approve/suspend customers (customers:approve)');
  end;
  reset role;

  -- T26 audit log: the super admin's price change is recorded with old and new
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.products set price = 33 where id = v_p1;
  select changes into v_json from public.audit_log
  where table_name = 'products' and row_id = v_p1::text and action = 'update' order by id desc limit 1;
  v_res := v_res || jsonb_build_array(case when (v_json -> 'price' ->> 'old')::numeric = 32 and (v_json -> 'price' ->> 'new')::numeric = 33
    then 'PASS T26a audit log shows price 32 -> 33 by admin' else 'FAIL T26a ' || coalesce(v_json::text, 'no row') end);
  update public.products set price = 32 where id = v_p1;
  select count(*) into v_n from public.audit_log where table_name = 'orders' and row_id = (v_o1 ->> 'id') and changes ? 'status';
  v_res := v_res || jsonb_build_array(case when v_n >= 4 then 'PASS T26b audit log recorded ' || v_n || ' status changes of order 1' else 'FAIL T26b rows ' || v_n end);
  select count(*) into v_n from public.audit_log where changed_by is null;
  v_res := v_res || jsonb_build_array(case when v_n < (select count(*) from public.audit_log) then 'PASS T26c audit rows carry the user who made the change' else 'FAIL T26c all rows anonymous' end);
  begin
    insert into public.audit_log (table_name, row_id, action, changes) values ('x', '1', 'insert', '{}');
    v_res := v_res || jsonb_build_array('FAIL T26d admin wrote to the audit log by hand');
  exception when insufficient_privilege then
    v_res := v_res || jsonb_build_array('PASS T26d nobody can write audit rows by hand');
  end;

  -- T27 a product hidden in a city is invisible and unorderable there
  insert into public.product_city_availability (product_id, city_id, is_available) values (v_p2, v_city, false);
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_rb, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.products where id = v_p2;
  v_res := v_res || jsonb_build_array(case when v_n = 0 then 'PASS T27a product hidden in Vizag is not in the customer catalogue' else 'FAIL T27a visible' end);
  begin
    perform public.place_order(jsonb_build_array(jsonb_build_object('product_id', v_p2, 'quantity', 2)), null, null, 'morning', 'cod', 'PO/2');
    v_res := v_res || jsonb_build_array('FAIL T27b ordered a product hidden in this city');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T27b cannot order a product hidden in this city');
  end;
  reset role;

  -- T28 customers without a served pin code cannot be approved
  update public.restaurants set warehouse_id = null, pincode = null where owner_id = v_rb;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.set_customer_status((select id from public.restaurants where owner_id = v_rb), 'approved');
    v_res := v_res || jsonb_build_array('FAIL T28 approved a customer with no warehouse');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T28 cannot approve a customer with no warehouse: ' || sqlerrm);
  end;
  reset role;

  -- T29 new admin logins get a team role automatically (invite-staff path)
  update public.profiles set role = 'admin' where id = v_inj;
  select team_role into v_txt from public.profiles where id = v_inj;
  v_res := v_res || jsonb_build_array(case when v_txt = 'super_admin' then 'PASS T29 promoted login defaults to super_admin team role' else 'FAIL T29 team_role ' || coalesce(v_txt, 'null') end);


  -- ===========================================================================
  -- Migration 009: pricing engine
  -- ===========================================================================

  -- T30 the formula itself, on fixed inputs. The same four cases live in
  -- tests/unit.test.js for web/js/core/pricing.js: both must give these numbers.
  v_json := public.compute_price_from('{"pricing_mode":"rule","cost_method":"quote","supplier_quote":24,"weight_kg":1,"transport_per_kg":1.5,"handling_per_kg":0.5,"packing_per_unit":0,"market_fee_pct":2,"other_cost_pct":0,"yield_pct":100,"wastage_pct":8,"markup_pct":15,"min_markup_pct":8,"rounding_step":0.5,"round_mode":"nearest","benchmark_price":32,"benchmark_cap_pct":10,"benchmark_age_days":1}'::jsonb);
  v_res := v_res || jsonb_build_array(case when (v_json ->> 'landed_cost')::numeric = 28.83 and (v_json ->> 'suggested_price')::numeric = 33 and (v_json ->> 'margin_amount')::numeric = 4.17 and v_json -> 'flags' = '[]'::jsonb
    then 'PASS T30a landed 28.83, price 33.00 (quote 24 + 2/kg, 2% fee, 8% wastage, 15% markup, step 0.5)' else 'FAIL T30a ' || v_json::text end);
  v_json := public.compute_price_from('{"pricing_mode":"rule","cost_method":"weighted_avg_30d","avg_cost_30d":100,"latest_cost":120,"weight_kg":1,"yield_pct":70,"wastage_pct":3,"markup_pct":10,"min_markup_pct":5,"rounding_step":5,"round_mode":"up","benchmark_price":150,"benchmark_age_days":9}'::jsonb);
  v_res := v_res || jsonb_build_array(case when (v_json ->> 'landed_cost')::numeric = 147.28 and (v_json ->> 'suggested_price')::numeric = 165 and v_json -> 'flags' = '["stale_benchmark","cost_moved"]'::jsonb
    then 'PASS T30b yield 70% and wastage 3% give landed 147.28, rounded up to 165; stale benchmark and cost move flagged' else 'FAIL T30b ' || v_json::text end);
  v_json := public.compute_price_from('{"pricing_mode":"manual","manual_price":20,"latest_cost":25,"cost_method":"latest","rounding_step":1,"round_mode":"nearest"}'::jsonb);
  v_res := v_res || jsonb_build_array(case when (v_json ->> 'suggested_price')::numeric = 20 and v_json -> 'flags' = '["manual","below_cost"]'::jsonb
    then 'PASS T30c manual price below cost is flagged below_cost' else 'FAIL T30c ' || v_json::text end);
  v_json := public.compute_price_from('{"pricing_mode":"rule","cost_method":"quote","supplier_quote":100,"markup_pct":50,"benchmark_price":120,"benchmark_cap_pct":10,"rounding_step":1,"round_mode":"nearest","min_markup_pct":40}'::jsonb);
  v_res := v_res || jsonb_build_array(case when (v_json ->> 'suggested_price')::numeric = 132 and (v_json ->> 'capped')::boolean and v_json -> 'flags' = '["capped","below_min_markup"]'::jsonb
    then 'PASS T30d benchmark cap 10% holds 150 down to 132 and flags the markup below the minimum' else 'FAIL T30d ' || v_json::text end);
  v_json := public.compute_price_from('{"pricing_mode":"rule","cost_method":"latest","markup_pct":10}'::jsonb);
  v_res := v_res || jsonb_build_array(case when v_json ->> 'suggested_price' is null and v_json -> 'flags' = '["no_cost"]'::jsonb
    then 'PASS T30e no cost on file gives no price and the no_cost flag' else 'FAIL T30e ' || v_json::text end);

  -- T31 customers see nothing of costs, rules or benchmarks (restaurant A is re-activated after T17 so the check is real)
  update public.profiles set is_active = true where id = v_ra;
  perform set_config('request.jwt.claims', json_build_object('sub', v_ra, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.pricing_rules;
  select count(*) + v_n into v_n from public.product_pricing;
  select count(*) + v_n into v_n from public.benchmark_prices;
  select count(*) + v_n into v_n from public.price_history;
  select count(*) + v_n into v_n from public.order_line_costs;
  v_res := v_res || jsonb_build_array(case when v_n = 0 then 'PASS T31a customer sees 0 rows of rules, overrides, benchmarks, history and line costs' else 'FAIL T31a sees ' || v_n end);
  begin
    perform public.compute_price(v_p1);
    v_res := v_res || jsonb_build_array('FAIL T31b customer computed a price');
  exception when insufficient_privilege then
    v_res := v_res || jsonb_build_array('PASS T31b customer cannot call compute_price');
  end;
  begin
    perform public.apply_prices(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'price', 1)));
    v_res := v_res || jsonb_build_array('FAIL T31c customer published a price');
  exception when insufficient_privilege then
    v_res := v_res || jsonb_build_array('PASS T31c customer cannot publish prices');
  end;
  select count(*) into v_n from public.hsn_codes;
  v_res := v_res || jsonb_build_array(case when v_n > 20 then 'PASS T31d signed-in users can read the HSN list (' || v_n || ' codes)' else 'FAIL T31d hsn ' || v_n end);
  reset role;

  -- T32 the board: tomato = weighted-average cost 20 (T12h receipt) → landed 21.74 → ×1.15 → 25.00
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.price_board();
  v_res := v_res || jsonb_build_array(case when v_n = 26 then 'PASS T32a price board lists all 26 active products' else 'FAIL T32a rows ' || v_n end);
  v_json := public.compute_price(v_p1);
  v_res := v_res || jsonb_build_array(case when (v_json ->> 'cost_basis')::numeric = 20 and (v_json ->> 'landed_cost')::numeric = 21.74 and (v_json ->> 'suggested_price')::numeric = 25 and v_json ->> 'rule_source' = 'category'
    then 'PASS T32b tomato: ledger cost 20, 8% wastage, 15% markup, step 0.5 → suggested 25.00 from the Vegetables rule' else 'FAIL T32b ' || v_json::text end);
  v_res := v_res || jsonb_build_array(case when v_json ->> 'benchmark_price' is null and v_json ->> 'hsn_code' is null then 'PASS T32c no benchmark on file yet' else 'FAIL T32c ' || coalesce(v_json ->> 'benchmark_price', 'null') end);

  -- T33 a benchmark caps the price: Rythu Bazaar 22 today, cap 10% → 24.2 → rounded 24.00; publishing writes product + history
  select id into v_src from public.benchmark_sources where code = 'rythu_bazaar';
  insert into public.benchmark_prices (source_id, product_id, price_date, price, market)
  values (v_src, v_p1, (now() at time zone 'Asia/Kolkata')::date, 22, 'MVP Colony');
  v_json := public.compute_price(v_p1);
  v_res := v_res || jsonb_build_array(case when (v_json ->> 'suggested_price')::numeric = 24 and (v_json ->> 'capped')::boolean and (v_json ->> 'benchmark_source') = 'rythu_bazaar'
    then 'PASS T33a benchmark 22 with 10% cap brings tomato from 25.00 to 24.00 (capped)' else 'FAIL T33a ' || v_json::text end);
  v_json := public.apply_prices(jsonb_build_array(jsonb_build_object('product_id', v_p1)), 'morning board');
  select price || '/' || market_price || '/' || price_source || '/' || benchmark_label into v_txt from public.products where id = v_p1;
  v_res := v_res || jsonb_build_array(case when (v_json ->> 'applied')::int = 1 and v_txt like '24.00/22.00/rule/Rythu Bazaar board (Visakhapatnam) · %'
    then 'PASS T33b publish set price 24, market price 22, source rule and the benchmark label' else 'FAIL T33b ' || v_txt end);
  select count(*) into v_n from public.price_history where product_id = v_p1 and old_price = 32 and new_price = 24 and reason = 'morning board' and changed_by = v_admin and cost_used = 21.74;
  v_res := v_res || jsonb_build_array(case when v_n = 1 then 'PASS T33c price history records old 32 → new 24, cost used and who' else 'FAIL T33c rows ' || v_n end);
  select count(*) into v_n from public.audit_log where table_name = 'products' and row_id = v_p1::text and changes -> 'price' ->> 'new' = '24.00';
  v_res := v_res || jsonb_build_array(case when v_n = 1 then 'PASS T33d audit log also saw the price change' else 'FAIL T33d rows ' || v_n end);

  -- T34 margin guard: below landed cost needs "publish anyway"; blocked outright when the rule says block
  begin
    perform public.apply_prices(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'price', 20)));
    v_res := v_res || jsonb_build_array('FAIL T34a published below cost without confirmation');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T34a below cost refused: ' || sqlerrm);
  end;
  v_json := public.apply_prices(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'price', 20)), 'clearance', null, true);
  select price into v_num from public.products where id = v_p1;
  v_res := v_res || jsonb_build_array(case when v_num = 20 then 'PASS T34b "publish anyway" allows it under guard_mode = warn' else 'FAIL T34b price ' || v_num end);
  begin
    perform public.apply_prices(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'price', 22)));
    v_res := v_res || jsonb_build_array('FAIL T34c published under the minimum markup without confirmation');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T34c under minimum markup refused: ' || sqlerrm);
  end;
  reset role;
  update public.pricing_rules set guard_mode = 'block' where category_id = (select category_id from public.products where id = v_p1);
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.apply_prices(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'price', 20)), null, null, true);
    v_res := v_res || jsonb_build_array('FAIL T34d guard_mode = block let a below-cost price through');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T34d guard_mode = block refuses even with "publish anyway"');
  end;
  reset role;
  update public.pricing_rules set guard_mode = 'warn' where category_id = (select category_id from public.products where id = v_p1);

  -- T35 a picker has no pricing permission
  perform set_config('request.jwt.claims', json_build_object('sub', v_pick, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.price_board();
    v_res := v_res || jsonb_build_array('FAIL T35a picker opened the price board');
  exception when insufficient_privilege then
    v_res := v_res || jsonb_build_array('PASS T35a picker cannot open the price board (pricing:view)');
  end;
  begin
    insert into public.benchmark_prices (source_id, product_id, price_date, price) values (v_src, v_p2, (now() at time zone 'Asia/Kolkata')::date, 1);
    v_res := v_res || jsonb_build_array('FAIL T35b picker entered a benchmark');
  exception when insufficient_privilege then
    v_res := v_res || jsonb_build_array('PASS T35b picker cannot enter benchmarks (pricing:edit)');
  end;
  reset role;

  -- T36 a pricing manager (matrix row) can publish but cannot approve customers
  -- The test gives paneer its own supplier quote (300) rather than relying on the sample
  -- quotes in seed.sql, which a live project need not have loaded. Rolled back with the rest.
  insert into public.product_pricing (product_id, supplier_quote, quote_date)
  values (v_p2, 300, (now() at time zone 'Asia/Kolkata')::date)
  on conflict (product_id) do update set supplier_quote = 300, quote_date = excluded.quote_date;
  insert into auth.users (id, aud, role, email, email_confirmed_at, raw_user_meta_data, created_at, updated_at) values
    (v_pm, 'authenticated', 'authenticated', 'pm@test.local', now(), '{}'::jsonb, now(), now());
  update public.profiles set role = 'admin', team_role = 'pricing_manager' where id = v_pm;
  perform set_config('request.jwt.claims', json_build_object('sub', v_pm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select (public.compute_price(v_p2) ->> 'suggested_price')::numeric into v_num;
  v_res := v_res || jsonb_build_array(case when v_num = 318 then 'PASS T36a pricing manager sees paneer suggested at 318 (quote 300 ÷ 0.98 wastage × 1.04 markup, step 1)' else 'FAIL T36a ' || coalesce(v_num::text, 'null') end);
  v_json := public.apply_prices(jsonb_build_array(jsonb_build_object('product_id', v_p2)), 'pm publish');
  v_res := v_res || jsonb_build_array(case when (v_json ->> 'applied')::int = 1 then 'PASS T36b pricing manager published paneer (pricing:approve from the matrix)' else 'FAIL T36b ' || v_json::text end);
  begin
    perform public.set_customer_status((select id from public.restaurants where owner_id = v_ra), 'suspended');
    v_res := v_res || jsonb_build_array('FAIL T36c pricing manager changed a customer status');
  exception when insufficient_privilege then
    v_res := v_res || jsonb_build_array('PASS T36c pricing manager cannot approve or suspend customers');
  end;
  reset role;

  -- T37 scheduled prices go live only when due; cancelling needs pricing:approve
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select price into v_num from public.products where sku = 'VEG-002';
  v_json := public.apply_prices(jsonb_build_array(jsonb_build_object('product_id', (select id from public.products where sku = 'VEG-002'), 'price', 30)), 'tomorrow', now() + interval '1 day');
  v_res := v_res || jsonb_build_array(case when (v_json ->> 'scheduled')::int = 1 and (select price from public.products where sku = 'VEG-002') = v_num
    then 'PASS T37a price for tomorrow is scheduled, today''s price unchanged (' || v_num || ')' else 'FAIL T37a ' || v_json::text end);
  select public.publish_due_prices() into v_n;
  v_res := v_res || jsonb_build_array(case when v_n = 0 then 'PASS T37b nothing due yet: publish_due_prices applied 0' else 'FAIL T37b applied ' || v_n end);
  reset role;
  update public.scheduled_prices set effective_at = now() - interval '1 minute' where status = 'pending' returning id into v_sched;
  select public.publish_due_prices() into v_n;   -- as the cron job would (no session user)
  select price into v_num from public.products where sku = 'VEG-002';
  v_res := v_res || jsonb_build_array(case when v_n = 1 and v_num = 30 then 'PASS T37c once due, publish_due_prices applied it: onion now 30' else 'FAIL T37c applied ' || v_n || ' price ' || v_num end);
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.cancel_scheduled_price(v_sched);
    v_res := v_res || jsonb_build_array('FAIL T37d cancelled an already applied price');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T37d an applied price cannot be cancelled: ' || sqlerrm);
  end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_ra, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.publish_due_prices();
    v_res := v_res || jsonb_build_array('FAIL T37e customer ran publish_due_prices');
  exception when insufficient_privilege then
    v_res := v_res || jsonb_build_array('PASS T37e customers cannot run publish_due_prices');
  end;
  reset role;

  -- T38 orders snapshot HSN and landed cost (order 1 was placed when tomato cost was the 24 quote → landed 26.09)
  select hsn_code into v_txt from public.order_items where order_id = (v_o1 ->> 'id')::uuid and product_id = v_p1;
  v_res := v_res || jsonb_build_array(case when v_txt = '0702' then 'PASS T38a order line carries HSN 0702 for the invoice' else 'FAIL T38a hsn ' || coalesce(v_txt, 'null') end);
  select c.unit_cost into v_num from public.order_line_costs c join public.order_items i on i.id = c.order_item_id
  where c.order_id = (v_o1 ->> 'id')::uuid and i.product_id = v_p1;
  v_res := v_res || jsonb_build_array(case when v_num = 26.09 then 'PASS T38b order line cost snapshot 26.09 kept apart from the customer-visible line' else 'FAIL T38b cost ' || coalesce(v_num::text, 'null') end);
  select count(*) into v_n from public.order_line_costs where order_id = (v_o1 ->> 'id')::uuid;
  v_res := v_res || jsonb_build_array(case when v_n = 2 then 'PASS T38c both lines of order 1 have a cost row' else 'FAIL T38c rows ' || v_n end);

  -- T39 a 30-day weighted average: receipts of 50 @ 20 (T12h) and 50 @ 30 → 25
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.receive_stock(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 50, 'unit_cost', 30)), null, 'second lot', v_wh);
  v_json := public.compute_price(v_p1);
  v_res := v_res || jsonb_build_array(case when (v_json ->> 'avg_cost_30d')::numeric = 25 and (v_json ->> 'latest_cost')::numeric = 30 and v_json -> 'flags' ? 'cost_moved'
    then 'PASS T39 weighted average 25 (50@20 + 50@30), latest 30, cost_moved flagged' else 'FAIL T39 ' || v_json::text end);
  reset role;


  -- ===========================================================================
  -- Migration 010: catalogue + (category tree, variants, loose weight, price lists)
  -- ===========================================================================

  -- T40 category tree: two levels, no cycles; pricing rules inherit from the parent
  select id into v_leafy from public.categories where name = 'Leafy greens';
  v_res := v_res || jsonb_build_array(case when v_leafy is not null and (select parent_id from public.categories where id = v_leafy) = (select category_id from public.products where id = v_p1)
    then 'PASS T40a migration seeded the tree: Leafy greens is under Vegetables' else 'FAIL T40a tree not seeded' end);
  begin
    update public.categories set parent_id = v_leafy where name = 'Vegetables';
    v_res := v_res || jsonb_build_array('FAIL T40b a parent became a child of its own child');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T40b cycle / depth refused: ' || sqlerrm);
  end;
  begin
    insert into public.categories (name, parent_id) values ('Test third level', v_leafy);
    v_res := v_res || jsonb_build_array('FAIL T40c a third level was allowed');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T40c third level refused: ' || sqlerrm);
  end;
  update public.products set category_id = v_leafy where id = v_p3;   -- coriander moves into Leafy greens
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_json := public.compute_price(v_p3);
  v_res := v_res || jsonb_build_array(case when v_json ->> 'rule_source' = 'parent' and (v_json ->> 'markup_pct')::numeric = 15 and v_json ->> 'category_name' = 'Vegetables › Leafy greens'
    then 'PASS T40d coriander in Leafy greens inherits the Vegetables rule (15 %), path shown' else 'FAIL T40d ' || v_json::text end);
  select count(*) into v_n from public.price_board((select category_id from public.products where id = v_p1));
  v_res := v_res || jsonb_build_array(case when v_n = 5 then 'PASS T40e board filtered on Vegetables includes its sub-categories (5 products)' else 'FAIL T40e rows ' || v_n end);
  reset role;

  -- T41 variants: one level only
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.products (sku, name, category_id, price, unit, min_order_qty, parent_product_id, variant_label, pack_size, pack_unit)
  values ('VEG-001-5', 'Tomato (Hybrid) 5 kg crate', (select category_id from public.products where id = v_p1), 150, 'crate', 1, v_p1, '5 kg crate', 5, 'kg')
  returning id into v_var;
  begin
    insert into public.products (sku, name, category_id, price, unit, parent_product_id)
    values ('VEG-001-5-X', 'Variant of a variant', (select category_id from public.products where id = v_p1), 1, 'x', v_var);
    v_res := v_res || jsonb_build_array('FAIL T41a a variant of a variant was allowed');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T41a variant of a variant refused: ' || sqlerrm);
  end;
  begin
    update public.products set parent_product_id = v_var where id = v_p1;
    v_res := v_res || jsonb_build_array('FAIL T41b a product with variants became a variant');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T41b a product with variants cannot become one: ' || sqlerrm);
  end;
  reset role;

  -- T42 price lists: a layer over the published price (paneer was hidden in Vizag by T27: show it again)
  update public.product_city_availability set is_available = true where product_id = v_p2;
  perform set_config('request.jwt.claims', json_build_object('sub', v_ra, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.price_lists;
  v_res := v_res || jsonb_build_array(case when v_n = 0 then 'PASS T42a customer sees no price lists' else 'FAIL T42a sees ' || v_n end);
  v_res := v_res || jsonb_build_array(case when public.my_price_list() = '[]'::jsonb then 'PASS T42b no list yet: my_price_list is empty' else 'FAIL T42b ' || public.my_price_list()::text end);
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.price_lists (name, sector_code, adjustment_pct) values ('Restaurants −5 %', 'restaurant', -5) returning id into v_list;
  insert into public.price_lists (name, city_id, adjustment_pct) values ('Vizag +2 %', v_city, 2);
  insert into public.price_list_items (price_list_id, product_id, price) values (v_list, v_p2, 300);   -- paneer fixed at 300
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_ra, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_json := public.my_price_list();
  select price into v_num from public.products where id = v_p1;
  v_res := v_res || jsonb_build_array(case when jsonb_array_length(v_json) >= 26
      and (select (e ->> 'price')::numeric from jsonb_array_elements(v_json) e where (e ->> 'product_id')::uuid = v_p1) = round(v_num * 0.95, 2)
    then 'PASS T42c sector list beats the city list: tomato ' || v_num || ' → ' || round(v_num * 0.95, 2) || ' for a restaurant' else 'FAIL T42c ' || v_json::text end);
  v_res := v_res || jsonb_build_array(case when (select (e ->> 'price')::numeric from jsonb_array_elements(v_json) e where (e ->> 'product_id')::uuid = v_p2) = 300
    then 'PASS T42d a fixed item price (paneer 300) beats the % adjustment' else 'FAIL T42d' end);
  v_o4 := public.place_order(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 10), jsonb_build_object('product_id', v_p2, 'quantity', 2)), 'price list order');
  select unit_price into v_num from public.order_items where order_id = (v_o4 ->> 'id')::uuid and product_id = v_p1;
  v_res := v_res || jsonb_build_array(case when v_num = round((select price from public.products where id = v_p1) * 0.95, 2)
      and (select unit_price from public.order_items where order_id = (v_o4 ->> 'id')::uuid and product_id = v_p2) = 300
    then 'PASS T42e place_order charges the price-list prices (tomato ' || v_num || ', paneer 300)' else 'FAIL T42e unit_price ' || v_num end);
  select ordered_quantity into v_num from public.order_items where order_id = (v_o4 ->> 'id')::uuid and product_id = v_p1;
  v_res := v_res || jsonb_build_array(case when v_num = 10 then 'PASS T42f order line keeps ordered_quantity 10' else 'FAIL T42f ' || v_num end);
  reset role;

  -- T43 billing on actual weight after packing
  update public.products set sold_by_weight = true, weight_tolerance_pct = 10 where id = v_p1;
  perform set_config('request.jwt.claims', json_build_object('sub', v_ra, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.set_packed_quantities((v_o4 ->> 'id')::uuid, '[]'::jsonb);
    v_res := v_res || jsonb_build_array('FAIL T43a customer could pack');
  exception when insufficient_privilege then
    v_res := v_res || jsonb_build_array('PASS T43a customers cannot record packed quantities');
  end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select id into v_item from public.order_items where order_id = (v_o4 ->> 'id')::uuid and product_id = v_p1;
  begin
    perform public.set_packed_quantities((v_o4 ->> 'id')::uuid, jsonb_build_array(jsonb_build_object('order_item_id', v_item, 'packed_quantity', 10.8)));
    v_res := v_res || jsonb_build_array('FAIL T43b packed a placed order');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T43b only confirmed / packed orders: ' || sqlerrm);
  end;
  perform public.set_order_status((v_o4 ->> 'id')::uuid, 'confirmed');
  begin
    perform public.set_packed_quantities((v_o4 ->> 'id')::uuid, jsonb_build_array(jsonb_build_object('order_item_id', v_item, 'packed_quantity', 11.5)));
    v_res := v_res || jsonb_build_array('FAIL T43c 15 % over was accepted');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T43c outside tolerance refused: ' || sqlerrm);
  end;
  select qty into v_stock1 from public.warehouse_stock where warehouse_id = v_wh and product_id = v_p1;
  v_json := public.set_packed_quantities((v_o4 ->> 'id')::uuid, jsonb_build_array(jsonb_build_object('order_item_id', v_item, 'packed_quantity', 10.8)));
  select quantity || '/' || ordered_quantity || '/' || line_total into v_txt from public.order_items where id = v_item;
  v_res := v_res || jsonb_build_array(case when v_txt = '10.80/10.00/' || round(10.8 * round((select price from public.products where id = v_p1) * 0.95, 2), 2)
    then 'PASS T43d billed 10.8 kg (ordered 10): line re-totalled at the list price' else 'FAIL T43d ' || v_txt end);
  select subtotal || '/' || total_amount into v_txt from public.orders where id = (v_o4 ->> 'id')::uuid;
  v_res := v_res || jsonb_build_array(case when (select subtotal from public.orders where id = (v_o4 ->> 'id')::uuid) = (select sum(line_total) from public.order_items where order_id = (v_o4 ->> 'id')::uuid)
    then 'PASS T43e order subtotal / total re-totalled (' || v_txt || ')' else 'FAIL T43e ' || v_txt end);
  select qty into v_num from public.warehouse_stock where warehouse_id = v_wh and product_id = v_p1;
  v_res := v_res || jsonb_build_array(case when v_num = v_stock1 - 0.8 then 'PASS T43f stock reservation corrected by the extra 0.8 kg' else 'FAIL T43f stock ' || v_stock1 || ' → ' || v_num end);
  select id into v_item from public.order_items where order_id = (v_o4 ->> 'id')::uuid and product_id = v_p2;
  begin
    perform public.set_packed_quantities((v_o4 ->> 'id')::uuid, jsonb_build_array(jsonb_build_object('order_item_id', v_item, 'packed_quantity', 3)));
    v_res := v_res || jsonb_build_array('FAIL T43g packed more paneer than ordered');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T43g a non-weight line cannot exceed the order: ' || sqlerrm);
  end;
  v_json := public.set_packed_quantities((v_o4 ->> 'id')::uuid, jsonb_build_array(jsonb_build_object('order_item_id', v_item, 'packed_quantity', 1)));
  v_res := v_res || jsonb_build_array(case when (select quantity from public.order_items where id = v_item) = 1 and (v_json ->> 'lines')::int = 1
    then 'PASS T43h short supply: paneer billed 1 of 2' else 'FAIL T43h ' || v_json::text end);
  select count(*) into v_n from public.audit_log where table_name = 'orders' and row_id = (v_o4 ->> 'id') and changes ? 'subtotal';
  v_res := v_res || jsonb_build_array(case when v_n >= 1 then 'PASS T43i the re-total is in the audit log' else 'FAIL T43i rows ' || v_n end);
  reset role;
  -- picker (orders:edit) may pack; a warehouse manager of another city may not
  perform set_config('request.jwt.claims', json_build_object('sub', v_pick, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_json := public.set_packed_quantities((v_o4 ->> 'id')::uuid, jsonb_build_array(jsonb_build_object('order_item_id', v_item, 'packed_quantity', 2)));
  v_res := v_res || jsonb_build_array(case when (v_json ->> 'lines')::int = 1 then 'PASS T43j a picker (orders:edit) can record packed quantities' else 'FAIL T43j' end);
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_cm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.set_packed_quantities((v_o4 ->> 'id')::uuid, jsonb_build_array(jsonb_build_object('order_item_id', v_item, 'packed_quantity', 2)));
    v_res := v_res || jsonb_build_array('FAIL T43k Hyderabad manager packed a Vizag order');
  exception when insufficient_privilege then
    v_res := v_res || jsonb_build_array('PASS T43k a manager of another city cannot pack it (scope)');
  end;
  reset role;


  -- ===========================================================================
  -- Migration 011: procurement
  -- ===========================================================================

  -- T44 customers and pickers see nothing of procurement
  perform set_config('request.jwt.claims', json_build_object('sub', v_ra, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.purchase_orders;
  select count(*) + v_n into v_n from public.supplier_products;
  select count(*) + v_n into v_n from public.goods_receipts;
  v_res := v_res || jsonb_build_array(case when v_n = 0 then 'PASS T44a customer sees 0 purchase orders, rate cards and receipts' else 'FAIL T44a sees ' || v_n end);
  begin
    perform public.create_purchase_order(null, v_wh, null, null, '[]'::jsonb);
    v_res := v_res || jsonb_build_array('FAIL T44b customer created a PO');
  exception when insufficient_privilege then
    v_res := v_res || jsonb_build_array('PASS T44b customer cannot create purchase orders');
  end;
  begin
    perform public.buying_list(v_wh, v_tomorrow);
    v_res := v_res || jsonb_build_array('FAIL T44c customer read the buying list');
  exception when insufficient_privilege then
    v_res := v_res || jsonb_build_array('PASS T44c customer cannot read the buying list');
  end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_pick, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.create_purchase_order(null, v_wh, null, null, '[]'::jsonb);
    v_res := v_res || jsonb_build_array('FAIL T44d picker created a PO');
  exception when insufficient_privilege then
    v_res := v_res || jsonb_build_array('PASS T44d picker cannot create purchase orders (procurement:edit)');
  end;
  reset role;

  -- T45 rate cards and the buying list (as a procurement buyer)
  insert into auth.users (id, aud, role, email, email_confirmed_at, raw_user_meta_data, created_at, updated_at) values
    (v_buyer, 'authenticated', 'authenticated', 'buyer@test.local', now(), '{}'::jsonb, now(), now());
  update public.profiles set role = 'admin', team_role = 'procurement_buyer', city_id = v_city where id = v_buyer;
  select id into v_sup from public.suppliers order by created_at limit 1;
  insert into public.suppliers (name, phone) values ('Second Farms', '9000000002') returning id into v_sup2;
  perform set_config('request.jwt.claims', json_build_object('sub', v_buyer, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.supplier_products (supplier_id, product_id, price, moq, lead_days, is_preferred) values (v_sup, v_p1, 21, 10, 1, true);
  insert into public.supplier_products (supplier_id, product_id, price, moq, lead_days) values (v_sup2, v_p1, 19.5, 50, 2);
  begin
    insert into public.supplier_products (supplier_id, product_id, price, is_preferred) values (v_sup2, v_p2, 290, true);
    insert into public.supplier_products (supplier_id, product_id, price, is_preferred) values (v_sup, v_p2, 295, true);
    v_res := v_res || jsonb_build_array('FAIL T45a two preferred suppliers for one product');
  exception when unique_violation then
    v_res := v_res || jsonb_build_array('PASS T45a only one preferred supplier per product');
  end;
  select coalesce(sum(i.quantity), 0) into v_num from public.orders o join public.order_items i on i.order_id = o.id
  where o.warehouse_id = v_wh and o.delivery_date = v_tomorrow and o.status in ('placed', 'confirmed', 'packed') and i.product_id = v_p1;
  select e into v_row from public.buying_list(v_wh, v_tomorrow, 1) e where (e ->> 'product_id')::uuid = v_p1;
  v_res := v_res || jsonb_build_array(case when v_row ->> 'supplier_name' = 'Sample Farms Co-op' and (v_row ->> 'rate')::numeric = 21 and (v_row ->> 'demand_qty')::numeric = v_num and v_num >= 10.8
    then 'PASS T45b buying list: tomato demand ' || v_num || ' for tomorrow (open orders), preferred supplier at 21 (cheaper non-preferred ignored)' else 'FAIL T45b ' || coalesce(v_row::text, 'no row') end);
  v_res := v_res || jsonb_build_array(case when (v_row ->> 'suggested_qty')::numeric = greatest(0, (v_row ->> 'demand_qty')::numeric * 1 + (v_row ->> 'low_stock_threshold')::numeric - (v_row ->> 'free_stock')::numeric - (v_row ->> 'open_po_qty')::numeric)
    then 'PASS T45c suggested = max(0, demand × cover + alert level − free stock − open POs)' else 'FAIL T45c ' || v_row::text end);
  select e into v_row from public.buying_list(v_wh, v_tomorrow, 30) e where (e ->> 'product_id')::uuid = v_p1;
  v_res := v_res || jsonb_build_array(case when (v_row ->> 'suggested_qty')::numeric = greatest(0, v_num * 30 + (v_row ->> 'low_stock_threshold')::numeric - (v_row ->> 'free_stock')::numeric) and (v_row ->> 'suggested_qty')::numeric > 0
    then 'PASS T45d 30 days of cover raises the suggestion accordingly' else 'FAIL T45d ' || v_row::text end);
  begin
    perform public.buying_list(v_wh2, v_tomorrow);
    v_res := v_res || jsonb_build_array('FAIL T45e Vizag buyer read the Hyderabad buying list');
  exception when insufficient_privilege then
    v_res := v_res || jsonb_build_array('PASS T45e buying list is limited to the buyer''s scope');
  end;

  -- T46 purchase order: draft by the buyer, approved by a manager
  v_po := public.create_purchase_order(v_sup, v_wh, v_tomorrow, 'morning run',
            jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 50), jsonb_build_object('product_id', v_p2, 'quantity', 5, 'unit_cost', 290)));
  select string_agg(qty_ordered || '@' || coalesce(unit_cost::text, 'null'), ',' order by qty_ordered desc) into v_txt
  from public.purchase_order_items where po_id = (v_po ->> 'id')::uuid;
  v_res := v_res || jsonb_build_array(case when v_po ->> 'po_number' like 'PO-%' and v_txt = '50.00@21.00,5.00@290.00'
    then 'PASS T46a ' || (v_po ->> 'po_number') || ' drafted: tomato cost from the rate card (21), paneer as typed (290)' else 'FAIL T46a ' || v_txt end);
  perform public.update_purchase_order((v_po ->> 'id')::uuid, v_tomorrow, 'morning run, 60 kg',
            jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 60, 'unit_cost', 21), jsonb_build_object('product_id', v_p2, 'quantity', 5, 'unit_cost', 290)));
  select qty_ordered into v_num from public.purchase_order_items where po_id = (v_po ->> 'id')::uuid and product_id = v_p1;
  v_res := v_res || jsonb_build_array(case when v_num = 60 then 'PASS T46b a draft can be edited (tomato now 60)' else 'FAIL T46b ' || v_num end);
  begin
    perform public.set_purchase_order_status((v_po ->> 'id')::uuid, 'sent');
    v_res := v_res || jsonb_build_array('FAIL T46c buyer approved a PO');
  exception when insufficient_privilege then
    v_res := v_res || jsonb_build_array('PASS T46c a buyer cannot approve (procurement:approve)');
  end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.set_purchase_order_status((v_po ->> 'id')::uuid, 'sent');
  select status || '/' || coalesce(approved_by::text, 'null') into v_txt from public.purchase_orders where id = (v_po ->> 'id')::uuid;
  v_res := v_res || jsonb_build_array(case when v_txt = 'sent/' || v_admin::text then 'PASS T46d approved and sent, approver recorded' else 'FAIL T46d ' || v_txt end);
  begin
    perform public.update_purchase_order((v_po ->> 'id')::uuid, v_tomorrow, 'x', jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 1)));
    v_res := v_res || jsonb_build_array('FAIL T46e edited a sent PO');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T46e a sent PO cannot be edited: ' || sqlerrm);
  end;
  select e into v_row from public.buying_list(v_wh, v_tomorrow, 1) e where (e ->> 'product_id')::uuid = v_p1;
  v_res := v_res || jsonb_build_array(case when (v_row ->> 'open_po_qty')::numeric = 60 then 'PASS T46f the buying list counts the 60 on order' else 'FAIL T46f open ' || (v_row ->> 'open_po_qty') end);

  -- T47 receiving against the PO with a quality check
  begin
    perform public.receive_goods(v_wh, null, (v_po ->> 'id')::uuid, 'po', jsonb_build_array(jsonb_build_object('product_id', v_p1, 'qty_accepted', 55, 'qty_rejected', 5)));
    v_res := v_res || jsonb_build_array('FAIL T47a rejected goods without a reason');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T47a rejected quantity needs a reason: ' || sqlerrm);
  end;
  begin
    perform public.receive_goods(v_wh, null, (v_po ->> 'id')::uuid, 'po', jsonb_build_array(jsonb_build_object('product_id', v_p3, 'qty_accepted', 1)));
    v_res := v_res || jsonb_build_array('FAIL T47b received a product that is not on the PO');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T47b a product not on the PO is refused: ' || sqlerrm);
  end;
  select qty into v_stock1 from public.warehouse_stock where warehouse_id = v_wh and product_id = v_p1;
  v_grn := public.receive_goods(v_wh, null, (v_po ->> 'id')::uuid, 'po',
             jsonb_build_array(jsonb_build_object('product_id', v_p1, 'qty_accepted', 55, 'qty_rejected', 5, 'reject_reason', 'bruised', 'grade', 'A')), 'first lot');
  select qty into v_num from public.warehouse_stock where warehouse_id = v_wh and product_id = v_p1;
  v_res := v_res || jsonb_build_array(case when v_grn ->> 'grn_number' like 'GRN-%' and v_num = v_stock1 + 55 and v_grn ->> 'po_status' = 'part_received'
    then 'PASS T47c ' || (v_grn ->> 'grn_number') || ': 55 accepted into stock, 5 rejected kept out, PO part-received' else 'FAIL T47c ' || v_grn::text || ' stock ' || v_num end);
  select unit_cost || '/' || note || '/' || coalesce(supplier_id::text, 'null') into v_txt from public.stock_movements
  where product_id = v_p1 and reason = 'received' order by created_at desc, seq desc limit 1;
  v_res := v_res || jsonb_build_array(case when v_txt = '21.00/' || (v_grn ->> 'grn_number') || '/' || v_sup::text
    then 'PASS T47d the ledger row carries the PO cost (21), the GRN number and the supplier' else 'FAIL T47d ' || v_txt end);
  select qty_received || '/' || qty_rejected into v_txt from public.purchase_order_items where po_id = (v_po ->> 'id')::uuid and product_id = v_p1;
  v_res := v_res || jsonb_build_array(case when v_txt = '55.00/5.00' then 'PASS T47e PO line shows 55 received, 5 rejected' else 'FAIL T47e ' || v_txt end);
  begin
    perform public.set_purchase_order_status((v_po ->> 'id')::uuid, 'cancelled');
    v_res := v_res || jsonb_build_array('FAIL T47f cancelled a PO with receipts');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T47f a PO with receipts cannot be cancelled: ' || sqlerrm);
  end;
  v_grn := public.receive_goods(v_wh, null, (v_po ->> 'id')::uuid, 'po', jsonb_build_array(jsonb_build_object('product_id', v_p2, 'qty_accepted', 5, 'unit_cost', 285)), 'paneer');
  v_res := v_res || jsonb_build_array(case when v_grn ->> 'po_status' = 'closed' then 'PASS T47g every line received: PO closed by itself' else 'FAIL T47g ' || v_grn::text end);
  select e into v_row from public.buying_list(v_wh, v_tomorrow, 1) e where (e ->> 'product_id')::uuid = v_p1;
  v_res := v_res || jsonb_build_array(case when (v_row ->> 'open_po_qty')::numeric = 0 then 'PASS T47h nothing left on order for tomato' else 'FAIL T47h open ' || (v_row ->> 'open_po_qty') end);
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_cm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.receive_goods(v_wh, v_sup, null, 'direct', jsonb_build_array(jsonb_build_object('product_id', v_p1, 'qty_accepted', 1)));
    v_res := v_res || jsonb_build_array('FAIL T47i Hyderabad manager received into Vizag');
  exception when insufficient_privilege then
    v_res := v_res || jsonb_build_array('PASS T47i receiving is limited to the warehouse scope');
  end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_ra, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.receive_goods(v_wh, v_sup, null, 'direct', jsonb_build_array(jsonb_build_object('product_id', v_p1, 'qty_accepted', 1)));
    v_res := v_res || jsonb_build_array('FAIL T47j customer received goods');
  exception when insufficient_privilege then
    v_res := v_res || jsonb_build_array('PASS T47j customers cannot receive goods');
  end;
  reset role;

  -- T48 mandi cash purchase (no PO): bill amount required, bill photo and cash flag kept
  perform set_config('request.jwt.claims', json_build_object('sub', v_buyer, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.receive_goods(v_wh, null, null, 'mandi', jsonb_build_array(jsonb_build_object('product_id', v_p1, 'qty_accepted', 20, 'unit_cost', 18)), 'mandi run');
    v_res := v_res || jsonb_build_array('FAIL T48a mandi purchase without a bill amount');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T48a mandi purchase needs the bill amount: ' || sqlerrm);
  end;
  v_grn := public.receive_goods(v_wh, null, null, 'mandi', jsonb_build_array(jsonb_build_object('product_id', v_p1, 'qty_accepted', 20, 'unit_cost', 18)), 'mandi run', 'bills/test.jpg', 360, true);
  select source || '/' || bill_amount || '/' || paid_cash || '/' || bill_photo_path || '/' || coalesce(supplier_id::text, 'none') into v_txt from public.goods_receipts where id = (v_grn ->> 'id')::uuid;
  v_res := v_res || jsonb_build_array(case when v_txt = 'mandi/360.00/true/bills/test.jpg/none' then 'PASS T48b mandi receipt kept with bill photo, amount and cash flag' else 'FAIL T48b ' || v_txt end);
  select count(*) into v_n from public.goods_receipts;
  v_res := v_res || jsonb_build_array(case when v_n = 3 then 'PASS T48c buyer sees the 3 receipts of the city' else 'FAIL T48c sees ' || v_n end);
  begin
    insert into public.goods_receipts (warehouse_id, city_id, source) values (v_wh, v_city, 'direct');
    v_res := v_res || jsonb_build_array('FAIL T48d receipt written by hand');
  exception when insufficient_privilege then
    v_res := v_res || jsonb_build_array('PASS T48d receipts cannot be written by hand');
  end;
  reset role;

  -- ===========================================================================
  -- Migration 012: fulfilment & delivery
  -- ===========================================================================

  -- A fresh approved customer and a fresh driver in Vizag, and ample stock, so
  -- the fulfilment / orders+ checks do not depend on earlier state.
  insert into auth.users (id, aud, role, email, email_confirmed_at, raw_user_meta_data, created_at, updated_at) values
    (v_rc,   'authenticated', 'authenticated', 'rc@test.local',   now(), '{"restaurant_name":"Trip Kitchen","address":"9 Dock Rd","phone":"9000000009","pincode":"530001"}'::jsonb, now(), now()),
    (v_drv2, 'authenticated', 'authenticated', 'drv2@test.local', now(), '{}'::jsonb, now(), now()),
    (v_disp, 'authenticated', 'authenticated', 'disp@test.local', now(), '{}'::jsonb, now(), now());
  update public.profiles set role = 'admin', team_role = 'dispatcher', city_id = v_city where id = v_disp;
  update public.profiles set role = 'delivery' where id = v_drv2;
  -- Pin the customer to Vizag (city + warehouse). The metadata sign-up only set the
  -- warehouse from the pin code; the real sign-up form also sends the city.
  update public.restaurants set status = 'approved', city_id = v_city, warehouse_id = v_wh where owner_id = v_rc;

  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.receive_stock(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 1000, 'unit_cost', 20), jsonb_build_object('product_id', v_p2, 'quantity', 200, 'unit_cost', 280)), null, 'bulk for batch 5/6', v_wh);
  reset role;

  -- T49 fulfilment permissions
  perform set_config('request.jwt.claims', json_build_object('sub', v_disp, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.pick_list(v_wh, v_tomorrow, null);
  v_res := v_res || jsonb_build_array('PASS T49a dispatcher can read the pick list (fulfilment:view)');
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_pick, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.pick_list(v_wh, v_tomorrow, null);
    v_res := v_res || jsonb_build_array('FAIL T49b picker read the pick list');
  exception when insufficient_privilege then
    v_res := v_res || jsonb_build_array('PASS T49b picker has no fulfilment, cannot read the pick list');
  end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_rc, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.create_trip(v_drv2, null, v_tomorrow, 'morning', array[gen_random_uuid()]);
    v_res := v_res || jsonb_build_array('FAIL T49c customer built a trip');
  exception when insufficient_privilege then
    v_res := v_res || jsonb_build_array('PASS T49c customers cannot build trips');
  end;
  reset role;

  -- T50 batches & expiry
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.receive_goods(v_wh, null, null, 'direct',
    jsonb_build_array(jsonb_build_object('product_id', v_p1, 'qty_accepted', 50, 'unit_cost', 20, 'batch_no', 'FRESH', 'expiry_date', (v_tomorrow + 1)::text),
                      jsonb_build_object('product_id', v_p1, 'qty_accepted', 30, 'unit_cost', 19, 'batch_no', 'OLD',   'expiry_date', ((now() at time zone 'Asia/Kolkata')::date - 1)::text)), 'batches');
  select count(*) into v_n from public.expiring_batches(v_wh, 3) e where e ->> 'batch_no' in ('FRESH', 'OLD');
  v_res := v_res || jsonb_build_array(case when v_n = 2 then 'PASS T50a expiring_batches lists the fresh and the already-expired batch' else 'FAIL T50a sees ' || v_n end);
  v_json := public.write_off_expired(v_wh);
  v_res := v_res || jsonb_build_array(case when (v_json ->> 'batches')::int >= 1 and (v_json ->> 'qty')::numeric >= 30
    then 'PASS T50b write_off_expired wrote off the expired batch (' || (v_json ->> 'qty') || ')' else 'FAIL T50b ' || v_json::text end);
  select remaining_qty into v_num from public.stock_batches where batch_no = 'OLD' and warehouse_id = v_wh;
  v_res := v_res || jsonb_build_array(case when v_num = 0 then 'PASS T50c the expired batch is now zero' else 'FAIL T50c remaining ' || v_num end);
  select remaining_qty into v_num from public.stock_batches where batch_no = 'FRESH' and warehouse_id = v_wh;
  v_res := v_res || jsonb_build_array(case when v_num = 50 then 'PASS T50d the in-date batch is untouched' else 'FAIL T50d remaining ' || v_num end);
  select count(*) into v_n from public.stock_movements where product_id = v_p1 and reason = 'wastage' and note like 'expired batch OLD%';
  v_res := v_res || jsonb_build_array(case when v_n = 1 then 'PASS T50e the write-off posted a wastage movement' else 'FAIL T50e wastage rows ' || v_n end);
  reset role;

  -- T51 trip sheet, dispatch, proof of delivery, doorstep return, COD cash
  perform set_config('request.jwt.claims', json_build_object('sub', v_rc, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_oc := public.place_order(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 10)), null, null, 'morning', 'cod');
  select delivery_date into v_ddate from public.orders where id = (v_oc ->> 'id')::uuid;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.set_order_status((v_oc ->> 'id')::uuid, 'confirmed');
  perform public.set_order_status((v_oc ->> 'id')::uuid, 'packed');
  insert into public.vehicles (city_id, registration, label) values (v_city, 'AP39-TRIP', 'Tempo') returning id into v_veh;
  v_trip := public.create_trip(v_drv2, v_veh, v_ddate, 'morning', array[(v_oc ->> 'id')::uuid], 'morning run');
  v_json := public.dispatch_trip((v_trip ->> 'id')::uuid);
  select status, pod_otp into v_txt, v_otp from public.orders where id = (v_oc ->> 'id')::uuid;
  v_res := v_res || jsonb_build_array(case when (v_json ->> 'dispatched')::int = 1 and v_txt = 'out_for_delivery' and v_otp is not null
    then 'PASS T51a ' || (v_trip ->> 'trip_number') || ' dispatched: order out for delivery with a POD OTP' else 'FAIL T51a ' || v_txt || '/' || coalesce(v_otp, 'no otp') end);
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_drv2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.complete_delivery((v_oc ->> 'id')::uuid, '0000', null, 'x');
    v_res := v_res || jsonb_build_array('FAIL T51b wrong OTP accepted');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T51b a wrong POD OTP is refused');
  end;
  v_json := public.complete_delivery((v_oc ->> 'id')::uuid, v_otp, 'delivery-pod/x.jpg', 'left at desk',
    jsonb_build_array(jsonb_build_object('order_item_id', (select id from public.order_items where order_id = (v_oc ->> 'id')::uuid and product_id = v_p1), 'qty', 2, 'reason', 'bruised')));
  -- v_rc is a restaurant-sector customer, so the T42 price list applies: tomato 19.00 (published 20 − 5%).
  v_res := v_res || jsonb_build_array(case when (v_json ->> 'total_amount')::numeric = 251 and (v_json ->> 'returned')::numeric = 38 and (v_json ->> 'cash_collected')::numeric = 251
    then 'PASS T51c delivered with a 2-unit doorstep return at the list price 19: 289 → 251, cash 251' else 'FAIL T51c ' || v_json::text end);
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select status || '/' || payment_status into v_txt from public.orders where id = (v_oc ->> 'id')::uuid;
  v_res := v_res || jsonb_build_array(case when v_txt = 'delivered/paid' then 'PASS T51d the order is delivered and the COD order is paid' else 'FAIL T51d ' || v_txt end);
  select amount into v_num from public.driver_cash where order_id = (v_oc ->> 'id')::uuid;
  v_res := v_res || jsonb_build_array(case when v_num = 251 then 'PASS T51e the driver''s cash for the order is recorded (251)' else 'FAIL T51e cash ' || coalesce(v_num::text, 'none') end);
  select count(*) into v_n from public.delivery_returns where order_id = (v_oc ->> 'id')::uuid and qty = 2;
  v_res := v_res || jsonb_build_array(case when v_n = 1 then 'PASS T51f the doorstep return is on record' else 'FAIL T51f return rows ' || v_n end);
  reset role;

  -- T52 cash settlement and scope
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.settle_driver_cash(v_drv2, 100, 'cash drop');
  select (e ->> 'in_hand')::numeric into v_num from public.driver_cash_summary() e where (e ->> 'driver_id')::uuid = v_drv2;
  v_res := v_res || jsonb_build_array(case when v_num = 151 then 'PASS T52a settle_driver_cash: 251 collected − 100 settled = 151 in hand' else 'FAIL T52a in hand ' || coalesce(v_num::text, 'none') end);
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_cm, 'role', 'authenticated')::text, true);   -- Hyderabad manager
  set local role authenticated;
  begin
    perform public.create_trip(v_drv2, null, v_ddate, 'morning', array[(v_oc ->> 'id')::uuid]);
    v_res := v_res || jsonb_build_array('FAIL T52b a Hyderabad manager built a Vizag trip');
  exception when insufficient_privilege then
    v_res := v_res || jsonb_build_array('PASS T52b trips are limited to the builder''s scope');
  end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_pick, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.settle_driver_cash(v_drv2, 50, 'x');
    v_res := v_res || jsonb_build_array('FAIL T52c a picker settled driver cash');
  exception when insufficient_privilege then
    v_res := v_res || jsonb_build_array('PASS T52c settling cash needs fulfilment:approve or payments:edit');
  end;
  reset role;


  -- ===========================================================================
  -- Migration 013: orders +
  -- ===========================================================================

  -- T53 slot cut-off and capacity
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.slot_config (city_id, slot, cutoff_hour) values (null, 'express', 0);                         -- express shut
  insert into public.slot_config (city_id, slot, cutoff_hour, capacity_orders) values (v_city, 'afternoon', 23, 1); -- cap 1, cutoff late
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_rc, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.place_order(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 10)), null, null, 'express', 'cod');
    v_res := v_res || jsonb_build_array('FAIL T53a ordered express past the cut-off');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T53a express past its cut-off is refused: ' || sqlerrm);
  end;
  -- capacity: the afternoon slot for a far date (cut-off does not apply) takes one, refuses the second.
  perform public.place_order(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 10)), null, v_later, 'afternoon', 'cod');
  begin
    perform public.place_order(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 10)), null, v_later, 'afternoon', 'cod');
    v_res := v_res || jsonb_build_array('FAIL T53b second order fit a full slot');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T53b a full slot (capacity 1) refuses the second order: ' || sqlerrm);
  end;
  reset role;
  -- staff place a late express order on behalf of the customer (cut-off bypassed)
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_json := public.place_order_for((select id from public.restaurants where owner_id = v_rc), jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 10)), 'on behalf', null, 'express', 'cod');
  v_res := v_res || jsonb_build_array(case when (v_json ->> 'order_number') like 'ORD-%' then 'PASS T53c staff place_order_for bypasses the cut-off' else 'FAIL T53c ' || v_json::text end);
  delete from public.slot_config where city_id is null and slot = 'express';   -- reopen for the edit tests below
  reset role;

  -- T54 edit an order
  perform set_config('request.jwt.claims', json_build_object('sub', v_rc, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_od := public.place_order(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 10)), null, null, 'morning', 'cod');
  v_json := public.edit_order((v_od ->> 'id')::uuid, jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 15)));
  v_res := v_res || jsonb_build_array(case when (v_json ->> 'total_amount')::numeric = 15 * 19 + 99 then 'PASS T54a customer edits a placed order (10 → 15 tomato at the list price 19), re-totalled' else 'FAIL T54a ' || v_json::text end);
  select quantity into v_num from public.order_items where order_id = (v_od ->> 'id')::uuid and product_id = v_p1;
  v_res := v_res || jsonb_build_array(case when v_num = 15 then 'PASS T54b the line and its stock reservation are rebuilt' else 'FAIL T54b qty ' || v_num end);
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.set_order_status((v_od ->> 'id')::uuid, 'confirmed');
  v_json := public.edit_order((v_od ->> 'id')::uuid, jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 15), jsonb_build_object('product_id', v_p2, 'quantity', 2)));
  v_res := v_res || jsonb_build_array(case when (v_json ->> 'total_amount')::numeric = 15*19 + 2*300 + round(2*300*0.05,2) + 99 then 'PASS T54c staff edit a confirmed order (adds 2 paneer at the fixed list price 300)' else 'FAIL T54c ' || v_json::text end);
  perform public.set_order_status((v_od ->> 'id')::uuid, 'packed');
  begin
    perform public.edit_order((v_od ->> 'id')::uuid, jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 5)));
    v_res := v_res || jsonb_build_array('FAIL T54d edited a packed order');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T54d a packed order can no longer be edited: ' || sqlerrm);
  end;
  reset role;

  -- T55 cancellation with the cut-off rule
  perform set_config('request.jwt.claims', json_build_object('sub', v_rc, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_oe := public.place_order(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 10)), null, null, 'morning', 'cod');
  perform public.cancel_order((v_oe ->> 'id')::uuid, 'changed my mind');
  v_res := v_res || jsonb_build_array(case when (select status from public.orders where id = (v_oe ->> 'id')::uuid) = 'cancelled'
    then 'PASS T55a a customer cancels a placed order before the cut-off' else 'FAIL T55a status ' || (select status::text from public.orders where id = (v_oe ->> 'id')::uuid) end);
  v_of := public.place_order(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 10)), null, null, 'morning', 'cod');
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.slot_config (city_id, slot, cutoff_hour) values (v_city, 'morning', 0);   -- morning now shut for v_city
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_rc, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.cancel_order((v_of ->> 'id')::uuid, 'too late');
    v_res := v_res || jsonb_build_array('FAIL T55b customer cancelled past the cut-off');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T55b a customer cannot cancel past the cut-off: ' || sqlerrm);
  end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.cancel_order((v_of ->> 'id')::uuid, 'customer rang');
  v_res := v_res || jsonb_build_array(case when (select status from public.orders where id = (v_of ->> 'id')::uuid) = 'cancelled'
    then 'PASS T55c staff can cancel past the cut-off' else 'FAIL T55c status ' || (select status::text from public.orders where id = (v_of ->> 'id')::uuid) end);
  delete from public.slot_config where city_id = v_city and slot = 'morning';
  reset role;

  -- T56 report an issue → credit note
  perform set_config('request.jwt.claims', json_build_object('sub', v_rc, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_iss := public.report_issue((v_oc ->> 'id')::uuid, 'quality', 'two pieces were bruised');   -- v_oc was delivered in T51
  v_res := v_res || jsonb_build_array(case when (v_iss ->> 'id') is not null then 'PASS T56a a customer reports an issue on a delivered order' else 'FAIL T56a ' || v_iss::text end);
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_json := public.resolve_issue((v_iss ->> 'id')::uuid, 'goodwill credit', 50, false);
  v_res := v_res || jsonb_build_array(case when (v_json ->> 'credit_note') like 'CN-%' and (v_json ->> 'amount')::numeric = 50
    then 'PASS T56b support resolves it and raises credit note ' || (v_json ->> 'credit_note') else 'FAIL T56b ' || v_json::text end);
  begin
    v_iss := public.report_issue((v_oc ->> 'id')::uuid, 'other', 'test');
    perform public.resolve_issue((v_iss ->> 'id')::uuid, 'too much', 999999, false);
    v_res := v_res || jsonb_build_array('FAIL T56c a credit note larger than the order was allowed');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T56c a credit note cannot exceed the order total');
  end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_ra, 'role', 'authenticated')::text, true);   -- a different customer
  set local role authenticated;
  select count(*) into v_n from public.credit_notes;
  v_res := v_res || jsonb_build_array(case when v_n = 0 then 'PASS T56d another customer sees none of these credit notes' else 'FAIL T56d sees ' || v_n end);
  reset role;

  -- ===========================================================================
  -- Migration 014: launch control (lite mode)
  -- ===========================================================================
  v_rcid := (select id from public.restaurants where owner_id = v_rc);

  -- T57 the three switches
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.sectors set is_active = false where code = 'restaurant';   -- settings:edit
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_rc, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.place_order(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 10)), null, null, 'morning', 'cod');
    v_res := v_res || jsonb_build_array('FAIL T57a a customer of a switched-off sector placed an order');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T57a a sector that is off takes no orders: ' || sqlerrm);
  end;
  v_json := public.my_order_terms();
  v_res := v_res || jsonb_build_array(case when (v_json ->> 'sector_active')::boolean = false and v_json ->> 'sector_code' = 'restaurant'
    then 'PASS T57b my_order_terms tells the customer app the sector is off' else 'FAIL T57b ' || v_json::text end);
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.sectors set is_active = true where code = 'restaurant';
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_pick, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.company_settings set pricing_mode = 'simple' where id = true;
  get diagnostics v_n = row_count;
  v_res := v_res || jsonb_build_array(case when v_n = 0 then 'PASS T57c a picker cannot flip the pricing mode (settings:edit)' else 'FAIL T57c rows ' || v_n end);
  begin
    perform public.launch_status();
    v_res := v_res || jsonb_build_array('FAIL T57d picker read launch_status');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T57d launch_status needs settings:view');
  end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_json := public.launch_status();
  v_res := v_res || jsonb_build_array(case when v_json ->> 'pricing_mode' = 'advanced' and v_json ->> 'stock_mode' = 'counted'
      and jsonb_array_length(v_json -> 'sectors') = (select count(*) from public.sectors)
      and (select (x ->> 'customers')::int from jsonb_array_elements(v_json -> 'sectors') x where x ->> 'code' = 'restaurant') >= 3
    then 'PASS T57e launch_status lists every sector with customer counts and the two modes' else 'FAIL T57e ' || v_json::text end);
  -- Simple stock mode: quantities are ignored and the ledger is never touched.
  update public.company_settings set stock_mode = 'simple' where id = true;
  select qty into v_stockc from public.warehouse_stock where warehouse_id = v_wh and product_id = v_p1;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_rc, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_og := public.place_order(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', v_stockc + 1000)), null, null, 'morning', 'cod');
  reset role;   -- warehouse_stock is staff-only: read the count as the database owner
  select qty into v_num from public.warehouse_stock where warehouse_id = v_wh and product_id = v_p1;
  v_res := v_res || jsonb_build_array(case when (v_og ->> 'id') is not null and v_num = v_stockc
      and not exists (select 1 from public.stock_movements where order_id = (v_og ->> 'id')::uuid)
      and not (select stock_reserved from public.orders where id = (v_og ->> 'id')::uuid)
    then 'PASS T57f simple stock mode: an order beyond the count is accepted and reserves nothing (stock_reserved = false)' else 'FAIL T57f stock ' || coalesce(v_num::text, 'null') || ' vs ' || coalesce(v_stockc::text, 'null') end);
  perform set_config('request.jwt.claims', json_build_object('sub', v_rc, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.cancel_order((v_og ->> 'id')::uuid, 'test');
  reset role;
  select qty into v_num from public.warehouse_stock where warehouse_id = v_wh and product_id = v_p1;
  v_res := v_res || jsonb_build_array(case when v_num = v_stockc and not exists (select 1 from public.stock_movements where order_id = (v_og ->> 'id')::uuid)
    then 'PASS T57g cancelling it returns nothing: an order only returns what it took' else 'FAIL T57g stock ' || coalesce(v_num::text, 'null') end);
  perform set_config('request.jwt.claims', json_build_object('sub', v_rc, 'role', 'authenticated')::text, true);
  set local role authenticated;
  -- v_oe (T55a) was placed and cancelled in counted mode; v_of likewise. Place one more in counted mode
  -- later (T57j) — here: an order placed in COUNTED mode and cancelled in SIMPLE mode still returns its stock.
  begin
    perform public.place_order(jsonb_build_array(jsonb_build_object('product_id', v_p3, 'quantity', 5)), null, null, 'morning', 'cod');
    v_res := v_res || jsonb_build_array('FAIL T57h an out-of-stock product was ordered in simple mode');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T57h the in-stock flag still rules in simple mode: ' || sqlerrm);
  end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.company_settings set stock_mode = 'counted' where id = true;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_rc, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.place_order(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', v_stockc + 1000)), null, null, 'morning', 'cod');
    v_res := v_res || jsonb_build_array('FAIL T57i counted mode accepted an order beyond stock');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T57i back in counted mode the stock check is on again: ' || sqlerrm);
  end;
  -- Flip mid-order: reserve 10 in counted mode, switch to simple, cancel → the 10 come back (the order keeps its mode).
  v_og := public.place_order(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 10)), null, null, 'morning', 'cod');
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.company_settings set stock_mode = 'simple' where id = true;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_rc, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.cancel_order((v_og ->> 'id')::uuid, 'flip test');
  reset role;
  select qty into v_num from public.warehouse_stock where warehouse_id = v_wh and product_id = v_p1;
  v_res := v_res || jsonb_build_array(case when v_num = v_stockc and (select stock_reserved from public.orders where id = (v_og ->> 'id')::uuid)
      and (select count(*) from public.stock_movements where order_id = (v_og ->> 'id')::uuid) = 2
    then 'PASS T57j an order placed in counted mode and cancelled in simple mode returns its stock (orders.stock_reserved)' else 'FAIL T57j stock ' || coalesce(v_num::text, 'null') || ' vs ' || coalesce(v_stockc::text, 'null') end);
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.company_settings set stock_mode = 'counted' where id = true;
  reset role;

  -- ===========================================================================
  -- Migration 015: payments & credit
  -- ===========================================================================

  -- T58 receipts and allocation
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*), coalesce(sum(a.amount), 0) into v_n, v_num
  from public.payments p join public.payment_allocations a on a.payment_id = p.id
  where p.restaurant_id = v_rcid and a.order_id = (v_oc ->> 'id')::uuid and p.method = 'cash';
  v_res := v_res || jsonb_build_array(case when v_n = 1 and v_num = 251
    then 'PASS T58a the COD order delivered in T51 got its cash receipt automatically (251)' else 'FAIL T58a ' || v_n || ' receipts, ' || v_num end);
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_rc, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_og := public.place_order(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 10)), null, null, 'morning', 'credit');
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.set_order_status((v_og ->> 'id')::uuid, 'confirmed');
  perform public.set_order_status((v_og ->> 'id')::uuid, 'packed');
  perform public.assign_delivery((v_og ->> 'id')::uuid, v_drv2);
  perform public.set_order_status((v_og ->> 'id')::uuid, 'out_for_delivery');
  perform public.set_order_status((v_og ->> 'id')::uuid, 'delivered');
  select due_date::text || '/' || payment_status::text || '/' || coalesce(delivered_at::text, 'none') into v_txt from public.orders where id = (v_og ->> 'id')::uuid;
  v_res := v_res || jsonb_build_array(case when (select due_date from public.orders where id = (v_og ->> 'id')::uuid) = v_today + 7
      and (select payment_status from public.orders where id = (v_og ->> 'id')::uuid) = 'unpaid'
      and (select delivered_at from public.orders where id = (v_og ->> 'id')::uuid) is not null
    then 'PASS T58b a delivered pay-later order gets a due date (today + 7 credit days) and stays unpaid' else 'FAIL T58b ' || v_txt end);
  v_json := public.customer_receivables(v_rcid);
  select (i ->> 'balance')::numeric into v_num from jsonb_array_elements(v_json -> 'open_items') i where i ->> 'id' = v_og ->> 'id';
  v_res := v_res || jsonb_build_array(case when v_num = 239 and (v_json ->> 'outstanding')::numeric = 239
    then 'PASS T58c the T56 credit note (50) applied itself to the first pay-later invoice: 289 → 239 open' else 'FAIL T58c ' || v_json::text end);
  v_pay := public.record_payment(v_rcid, 239, 'upi', 'UTR0001', v_today, 'GPay');
  select payment_status::text into v_txt from public.orders where id = (v_og ->> 'id')::uuid;
  v_res := v_res || jsonb_build_array(case when (v_pay ->> 'receipt_number') like 'RCT-%' and (v_pay ->> 'unallocated')::numeric = 0 and v_txt = 'paid'
    then 'PASS T58d a UPI receipt of 239 settles the invoice oldest-due-first: order paid, ' || (v_pay ->> 'receipt_number') else 'FAIL T58d ' || v_pay::text || ' ' || v_txt end);
  begin
    perform public.record_payment(v_rcid, 10, 'upi', null);
    v_res := v_res || jsonb_build_array('FAIL T58e a UPI receipt without a reference was accepted');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T58e UPI / bank / cheque receipts need a reference');
  end;
  perform public.void_payment((v_pay ->> 'id')::uuid, 'typed the wrong customer');
  select payment_status::text into v_txt from public.orders where id = (v_og ->> 'id')::uuid;
  v_json := public.customer_receivables(v_rcid);
  v_res := v_res || jsonb_build_array(case when v_txt = 'unpaid' and (v_json ->> 'outstanding')::numeric = 239
    then 'PASS T58f voiding the receipt reopens the invoice (nothing deleted)' else 'FAIL T58f ' || v_txt || ' ' || v_json::text end);
  v_pay := public.record_payment(v_rcid, 300, 'cash', null, v_today, null,
                                 jsonb_build_array(jsonb_build_object('order_id', v_og ->> 'id', 'amount', 239)));
  select payment_status::text into v_txt from public.orders where id = (v_og ->> 'id')::uuid;
  v_res := v_res || jsonb_build_array(case when v_txt = 'paid' and (v_pay ->> 'unallocated')::numeric = 61
    then 'PASS T58g a receipt allocated by hand: 239 to the invoice, 61 left on account' else 'FAIL T58g ' || v_txt || ' ' || v_pay::text end);
  begin
    perform public.allocate_payment((v_pay ->> 'id')::uuid, jsonb_build_array(jsonb_build_object('order_id', v_og ->> 'id', 'amount', 1)));
    v_res := v_res || jsonb_build_array('FAIL T58h allocated more than the invoice balance');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T58h cannot allocate past an invoice balance: ' || sqlerrm);
  end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_pick, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.void_payment((v_pay ->> 'id')::uuid, 'x');
    v_res := v_res || jsonb_build_array('FAIL T58i picker voided a receipt');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T58i voiding needs payments:approve');
  end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_rc, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_json := public.customer_statement(v_rcid, v_today - 30, v_today);
  select count(*) into v_n from public.payments;   -- RLS: only own receipts
  v_res := v_res || jsonb_build_array(case when (v_json ->> 'closing_balance')::numeric = -61 and jsonb_array_length(v_json -> 'lines') >= 5
      and v_n = (select count(*) from public.payments where restaurant_id = v_rcid)
    then 'PASS T58j the customer reads their own statement (closing −61 = 61 on account) and sees only their own receipts' else 'FAIL T58j ' || v_json::text || ' receipts ' || v_n end);
  begin
    perform public.customer_receivables((select id from public.restaurants where owner_id = v_ra));
    v_res := v_res || jsonb_build_array('FAIL T58k a customer read another customer''s receivables');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T58k a customer cannot read another customer''s receivables');
  end;
  begin
    perform public.receivables_summary();
    v_res := v_res || jsonb_build_array('FAIL T58l a customer read the receivables report');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T58l receivables_summary needs payments:view');
  end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  -- Restaurant A's COD order v_o1 was delivered from the Orders screen (set_order_status, T14): at delivery it
  -- became cash in the driver's hand and paid, with its own receipt; the 1293 advance from T12l is still on account.
  select count(*) into v_n from public.receivables_summary() r where r ->> 'restaurant_id' = (select id::text from public.restaurants where owner_id = v_ra) and (r ->> 'unapplied_credit')::numeric = 1293;
  select payment_status::text into v_txt from public.orders where id = (v_o1 ->> 'id')::uuid;
  v_res := v_res || jsonb_build_array(case when v_n = 1 and v_txt = 'paid'
      and exists (select 1 from public.driver_cash where order_id = (v_o1 ->> 'id')::uuid and driver_id = v_del)
      and exists (select 1 from public.payments p join public.payment_allocations a on a.payment_id = p.id where a.order_id = (v_o1 ->> 'id')::uuid and p.method = 'cash' and p.received_by = v_del)
    then 'PASS T58m a COD order delivered from the Orders screen is cash in the driver''s hand: paid, driver cash, receipt; the advance stays on account' else 'FAIL T58m rows ' || v_n || ' ' || v_txt end);
  -- No cash was in fact collected: void the cash receipt, then apply the advance by hand.
  perform public.void_payment((select p.id from public.payments p join public.payment_allocations a on a.payment_id = p.id where a.order_id = (v_o1 ->> 'id')::uuid and p.method = 'cash'), 'driver collected nothing: prepaid');
  v_json := public.allocate_payment((select id from public.payments where restaurant_id = (select id from public.restaurants where owner_id = v_ra) and method = 'cash' and voided_at is null and note like 'advance%' limit 1),
                                    jsonb_build_array(jsonb_build_object('order_id', v_o1 ->> 'id', 'amount', 1293)));
  select payment_status::text into v_txt from public.orders where id = (v_o1 ->> 'id')::uuid;
  v_res := v_res || jsonb_build_array(case when v_txt = 'paid' and (v_json ->> 'unallocated')::numeric = 0
    then 'PASS T58n void the uncollected cash receipt, apply the advance by hand: order paid, nothing on account' else 'FAIL T58n ' || v_txt || ' ' || v_json::text end);
  v_stats := public.admin_dashboard_stats();
  v_res := v_res || jsonb_build_array(case when (v_stats ? 'receivables_open') and (v_stats ? 'receivables_overdue')
    then 'PASS T58o the dashboard carries open and overdue receivables' else 'FAIL T58o ' || v_stats::text end);
  reset role;

  -- T59 credit limit and overdue block
  update public.restaurants set credit_limit = 100 where id = v_rcid;   -- as postgres: the Customers screen does this with customers:edit
  perform set_config('request.jwt.claims', json_build_object('sub', v_rc, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.place_order(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 10)), null, null, 'morning', 'credit');
    v_res := v_res || jsonb_build_array('FAIL T59a a pay-later order above the credit limit was accepted');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T59a a pay-later order above the credit limit is refused: ' || sqlerrm);
  end;
  v_json := public.my_order_terms();
  v_res := v_res || jsonb_build_array(case when (v_json ->> 'credit_limit')::numeric = 100 and (v_json ->> 'credit_available')::numeric = 161 and v_json ->> 'credit_blocked_reason' is null
    then 'PASS T59b my_order_terms shows the limit (100) and what is available (161: the 61 on account counts)' else 'FAIL T59b ' || v_json::text end);
  v_oh := public.place_order(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 10)), null, null, 'morning', 'cod');
  v_res := v_res || jsonb_build_array(case when (v_oh ->> 'id') is not null then 'PASS T59c cash on delivery is still open to them' else 'FAIL T59c' end);
  perform public.cancel_order((v_oh ->> 'id')::uuid, 'test');
  reset role;
  update public.restaurants set credit_limit = null where id = v_rcid;
  -- Make the paid-by-hand invoice overdue and open again: void its receipt, back-date the due date.
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.void_payment((v_pay ->> 'id')::uuid, 'bounced');
  reset role;
  update public.orders set due_date = v_today - 1 where id = (v_og ->> 'id')::uuid;
  perform set_config('request.jwt.claims', json_build_object('sub', v_rc, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_json := public.my_order_terms();
  begin
    perform public.place_order(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 10)), null, null, 'morning', 'credit');
    v_res := v_res || jsonb_build_array('FAIL T59d a customer with an overdue invoice ordered on credit');
  exception when others then
    v_res := v_res || jsonb_build_array(case when (v_json ->> 'overdue')::numeric = 239 and v_json ->> 'credit_blocked_reason' like 'You have overdue invoices%'
      then 'PASS T59d an overdue invoice (239) blocks pay-later orders and the cart is told why' else 'FAIL T59d ' || v_json::text end);
  end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.sectors set block_credit_when_overdue = false where code = 'restaurant';
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_rc, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_oh := public.place_order(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 10)), null, null, 'morning', 'credit');
  v_res := v_res || jsonb_build_array(case when (v_oh ->> 'id') is not null then 'PASS T59e with the sector''s overdue block off, the order goes through' else 'FAIL T59e' end);
  perform public.cancel_order((v_oh ->> 'id')::uuid, 'test');
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.sectors set block_credit_when_overdue = true where code = 'restaurant';
  select count(*) into v_n from public.receivables_summary() r where r ->> 'restaurant_id' = v_rcid::text and (r ->> 'd1_30')::numeric = 239 and (r ->> 'overdue')::numeric = 239;
  v_res := v_res || jsonb_build_array(case when v_n = 1 then 'PASS T59f the ageing report puts the 239 in the 1–30 days bucket' else 'FAIL T59f rows ' || v_n end);
  reset role;

  -- T60 debit notes and online receipts (webhook path)
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_json := public.raise_debit_note(v_rcid, 40, 'crate not returned', (v_og ->> 'id')::uuid, null);
  v_bal := public.customer_receivables(v_rcid);
  v_res := v_res || jsonb_build_array(case when (v_json ->> 'debit_note_number') like 'DN-%' and (v_bal ->> 'outstanding')::numeric = 279
    then 'PASS T60a a debit note of 40 is an open item: outstanding 239 + 40 = 279' else 'FAIL T60a ' || v_bal::text end);
  reset role;
  set local role service_role;
  v_json := public.record_online_payment(v_rcid, 279, 'razorpay', 'pay_TEST001', v_today, 'webhook');
  v_pay  := public.record_online_payment(v_rcid, 279, 'razorpay', 'pay_TEST001', v_today, 'webhook retry');
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_bal := public.customer_receivables(v_rcid);
  select count(*) into v_n from public.payments where gateway_ref = 'pay_TEST001';
  v_res := v_res || jsonb_build_array(case when (v_json ->> 'duplicate')::boolean = false and (v_pay ->> 'duplicate')::boolean = true and v_n = 1
      and (v_bal ->> 'outstanding')::numeric = 0 and (select payment_status from public.orders where id = (v_og ->> 'id')::uuid) = 'paid'
    then 'PASS T60b an online receipt settles the invoice and the debit note; a webhook retry is ignored' else 'FAIL T60b ' || v_json::text || ' ' || v_pay::text || ' ' || v_bal::text end);
  begin
    perform public.record_online_payment(v_rcid, 1, 'razorpay', 'pay_TEST002');
    v_res := v_res || jsonb_build_array('FAIL T60c a signed-in admin called the webhook-only function');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T60c record_online_payment is service-role only');
  end;
  reset role;

  -- T61 customer logins (migration 016): staff see confirmation state in scope; customers / pickers do not
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*), count(*) filter (where not email_confirmed) into v_n, v_num from public.admin_customer_logins();
  v_res := v_res || jsonb_build_array(case when v_n >= 4 and v_num >= 0
    then 'PASS T61a admin_customer_logins lists every customer with email + confirmed flag (' || v_n || ' rows)' else 'FAIL T61a ' || v_n end);
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_pick, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.admin_customer_logins();
    v_res := v_res || jsonb_build_array('FAIL T61b picker read customer logins');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T61b admin_customer_logins needs customers:view');
  end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_cm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.admin_customer_logins();
  v_res := v_res || jsonb_build_array(case when v_n = 0 then 'PASS T61c a manager of another city sees no customer logins (scope)' else 'FAIL T61c sees ' || v_n end);
  reset role;

  -- T62 customer edit / cancel window (migration 017)
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.sectors set customer_edit_window_minutes = 15 where code = 'restaurant';
  update public.sectors set customer_edit_window_minutes = 0  where code = 'defence';
  reset role;
  -- v_rc is a restaurant-sector customer. Place a fresh order; backdate it to simulate the window passing.
  perform set_config('request.jwt.claims', json_build_object('sub', v_rc, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_og := public.place_order(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 10)), null, null, 'morning', 'cod');
  perform public.edit_order((v_og ->> 'id')::uuid, jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 12)));
  v_res := v_res || jsonb_build_array(case when (select quantity from public.order_items where order_id = (v_og ->> 'id')::uuid) = 12
    then 'PASS T62a a customer edits their own placed order inside the 15-minute window' else 'FAIL T62a' end);
  reset role;
  update public.orders set created_at = created_at - interval '20 minutes' where id = (v_og ->> 'id')::uuid;
  perform set_config('request.jwt.claims', json_build_object('sub', v_rc, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.edit_order((v_og ->> 'id')::uuid, jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 8)));
    v_res := v_res || jsonb_build_array('FAIL T62b edited past the window');
  exception when others then
    v_res := v_res || jsonb_build_array(case when sqlerrm like '%15-minute window%passed%' then 'PASS T62b past the window the customer cannot edit: ' || sqlerrm else 'FAIL T62b ' || sqlerrm end);
  end;
  begin
    perform public.cancel_order((v_og ->> 'id')::uuid, 'too late');
    v_res := v_res || jsonb_build_array('FAIL T62c cancelled past the window');
  exception when others then
    v_res := v_res || jsonb_build_array(case when sqlerrm like '%15-minute window%passed%' then 'PASS T62c past the window the customer cannot cancel' else 'FAIL T62c ' || sqlerrm end);
  end;
  reset role;
  -- Staff still can:
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.edit_order((v_og ->> 'id')::uuid, jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 7)));
  v_res := v_res || jsonb_build_array(case when (select quantity from public.order_items where order_id = (v_og ->> 'id')::uuid) = 7
    then 'PASS T62d staff can still edit the order past the window' else 'FAIL T62d' end);
  -- window 0 = no self-edit. Give v_rc a defence sector-code via a fresh order on a defence customer? Simpler:
  -- flip the restaurant sector to 0 for one assertion.
  update public.sectors set customer_edit_window_minutes = 0 where code = 'restaurant';
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_rc, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_oh := public.place_order(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 10)), null, null, 'morning', 'cod');
  begin
    perform public.edit_order((v_oh ->> 'id')::uuid, jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 11)));
    v_res := v_res || jsonb_build_array('FAIL T62e window 0 allowed self-edit');
  exception when others then
    v_res := v_res || jsonb_build_array(case when sqlerrm like '%through our team%' then 'PASS T62e window 0: self-edit refused with "call us"' else 'FAIL T62e ' || sqlerrm end);
  end;
  v_json := public.my_order_terms();
  v_res := v_res || jsonb_build_array(case when (v_json ->> 'customer_edit_window_minutes')::int = 0
    then 'PASS T62f my_order_terms carries the window to the customer app' else 'FAIL T62f ' || v_json::text end);
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.sectors set customer_edit_window_minutes = 15 where code = 'restaurant';
  reset role;

  -- T63 notifications & support (migration 018)
  -- v_rc placed orders above; the sector-default settings queue an SMS per status change (phone 9000000009).
  select count(*) into v_n from public.notifications where restaurant_id = v_rcid and event = 'order_placed' and channel = 'sms' and to_address = '919000000009';
  v_res := v_res || jsonb_build_array(case when v_n >= 1 then 'PASS T63a placing an order queues an SMS to the customer (' || v_n || ' queued)' else 'FAIL T63a ' || v_n end);
  select count(*) into v_n from public.notifications where restaurant_id = v_rcid and event = 'order_delivered';
  v_res := v_res || jsonb_build_array(case when v_n >= 1 then 'PASS T63b delivery queues an order_delivered message' else 'FAIL T63b ' || v_n end);
  select count(*) into v_n from public.notifications where restaurant_id = v_rcid and event = 'receipt_recorded';
  v_res := v_res || jsonb_build_array(case when v_n >= 1 then 'PASS T63c a receipt queues a receipt_recorded message' else 'FAIL T63c ' || v_n end);
  -- Payment reminders: v_og (credit, delivered) is paid by now; make a fresh overdue one.
  reset role;
  update public.sectors set customer_edit_window_minutes = 15 where code = 'restaurant';
  perform set_config('request.jwt.claims', json_build_object('sub', v_rc, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_oh := public.place_order(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 10)), null, null, 'morning', 'credit');
  reset role;
  update public.orders set status = 'delivered', delivered_at = now() - interval '10 days', due_date = v_today - 3 where id = (v_oh ->> 'id')::uuid;
  set local role service_role;
  v_n := public.queue_payment_reminders();
  v_num := public.queue_payment_reminders();   -- second run the same day: deduped
  reset role;
  v_res := v_res || jsonb_build_array(case when v_n >= 1 and v_num = 0
      and exists (select 1 from public.notifications where order_id = (v_oh ->> 'id')::uuid and event = 'payment_overdue' and dedupe_key = 'payment_overdue:' || (v_oh ->> 'id'))
    then 'PASS T63d queue_payment_reminders queues an overdue reminder once (second run deduped)' else 'FAIL T63d ' || v_n || '/' || v_num end);
  set local role service_role;
  select count(*) into v_n from public.claim_notifications(5);
  v_json := (select to_jsonb(x) from (select status, attempts from public.notifications where status = 'sending' limit 1) x);
  perform public.mark_notification((select id from public.notifications where status = 'sending' limit 1), 'sent', 'httpsms', 'msg_1');
  reset role;
  v_res := v_res || jsonb_build_array(case when v_n = 5 and (v_json ->> 'attempts')::int = 1
      and (select count(*) from public.notifications where status = 'sent' and provider = 'httpsms') = 1
    then 'PASS T63e the sender claims a batch (status sending, attempts 1) and marks one sent' else 'FAIL T63e ' || v_n || ' ' || coalesce(v_json::text, 'null') end);
  perform set_config('request.jwt.claims', json_build_object('sub', v_pick, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.claim_notifications(1);
    v_res := v_res || jsonb_build_array('FAIL T63f picker claimed notifications');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T63f claim_notifications is service-role only');
  end;
  reset role;
  -- Tickets
  perform set_config('request.jwt.claims', json_build_object('sub', v_rc, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_json := public.open_ticket('Wrong grade of tomato', 'The tomatoes were grade B, we ordered A', (v_oh ->> 'id')::uuid);
  v_res := v_res || jsonb_build_array(case when (v_json ->> 'ticket_number') like 'TKT-%' then 'PASS T63g a customer opens a ticket ' || (v_json ->> 'ticket_number') else 'FAIL T63g ' || v_json::text end);
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.reply_ticket((v_json ->> 'id')::uuid, 'Sorry about that — a credit note is on its way.');
  select status || '/' || coalesce(assigned_to::text, 'none') into v_txt from public.support_tickets where id = (v_json ->> 'id')::uuid;
  v_res := v_res || jsonb_build_array(case when v_txt = 'waiting_customer/' || v_admin::text
      and exists (select 1 from public.notifications where ticket_id = (v_json ->> 'id')::uuid and event = 'ticket_reply')
    then 'PASS T63h a staff reply sets waiting_customer, assigns the replier and notifies the customer' else 'FAIL T63h ' || v_txt end);
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_ra, 'role', 'authenticated')::text, true);   -- another customer
  set local role authenticated;
  select count(*) into v_n from public.support_tickets where id = (v_json ->> 'id')::uuid;
  begin
    perform public.reply_ticket((v_json ->> 'id')::uuid, 'me too');
    v_res := v_res || jsonb_build_array('FAIL T63i another customer replied on the ticket');
  exception when others then
    v_res := v_res || jsonb_build_array(case when v_n = 0 then 'PASS T63i another customer neither sees nor can reply on the ticket' else 'FAIL T63i sees ' || v_n end);
  end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_rc, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.set_ticket((v_json ->> 'id')::uuid, 'closed');
  begin
    perform public.set_ticket((v_json ->> 'id')::uuid, 'open', v_admin);
    v_res := v_res || jsonb_build_array('FAIL T63j customer reassigned a ticket');
  exception when others then
    v_res := v_res || jsonb_build_array(case when (select status from public.support_tickets where id = (v_json ->> 'id')::uuid) = 'closed'
      then 'PASS T63j the customer may close their own ticket but not reopen or assign it' else 'FAIL T63j' end);
  end;
  reset role;
  -- Help centre: the public reads 'public' articles only; settings:edit writes.
  set local role anon;
  select count(*), count(*) filter (where audience <> 'public') into v_n, v_num from public.help_articles;
  reset role;
  v_res := v_res || jsonb_build_array(case when v_n >= 5 and v_num = 0 then 'PASS T63k the website reads the public help articles only (' || v_n || ')' else 'FAIL T63k ' || v_n || '/' || v_num end);
  perform set_config('request.jwt.claims', json_build_object('sub', v_pick, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.help_articles set title = 'x' where slug = 'who-can-order';
  get diagnostics v_n = row_count;
  v_res := v_res || jsonb_build_array(case when v_n = 0 then 'PASS T63l a picker cannot edit help articles (settings:edit)' else 'FAIL T63l rows ' || v_n end);
  reset role;
  -- Map pin
  perform set_config('request.jwt.claims', json_build_object('sub', v_rc, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.update_my_location(17.6868, 83.2185);
  v_res := v_res || jsonb_build_array(case when (select lat::text || ',' || lng::text from public.restaurants where id = v_rcid) = '17.686800,83.218500'
    then 'PASS T63m the customer drops their own map pin' else 'FAIL T63m' end);
  begin
    perform public.update_my_location(95, 83);
    v_res := v_res || jsonb_build_array('FAIL T63n an impossible latitude was accepted');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T63n an impossible location is refused');
  end;
  reset role;
  v_res := v_res || jsonb_build_array(case when public.render_template('Hi {customer}, {order} {nope}', '{"customer":"A","order":"ORD-1"}'::jsonb) = 'Hi A, ORD-1 {nope}'
    then 'PASS T63o render_template fills known placeholders and leaves unknown ones visible' else 'FAIL T63o' end);

  -- T64 reports & dashboard (migration 019)
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_json := public.sales_report(v_today - 30, v_today + 7, 'day');
  v_res := v_res || jsonb_build_array(case when jsonb_array_length(v_json) >= 1 and (v_json -> 0) ? 'total' and (v_json -> 0) ? 'cancelled'
    then 'PASS T64a sales_report by day returns rows with totals and a cancelled count' else 'FAIL T64a ' || v_json::text end);
  v_json := public.sales_report(v_today - 30, v_today + 7, 'product');
  v_res := v_res || jsonb_build_array(case when jsonb_array_length(v_json) >= 1 and (v_json -> 0 ->> 'quantity') is not null
    then 'PASS T64b sales_report by product carries quantities' else 'FAIL T64b ' || v_json::text end);
  v_json := public.sales_report(v_today - 30, v_today + 7, 'sector');
  select sum((x ->> 'total')::numeric) into v_num from jsonb_array_elements(v_json) x;
  select coalesce(sum(total_amount), 0) into v_stockc from public.orders where status <> 'cancelled' and created_at >= (v_today - 30)::timestamp at time zone 'Asia/Kolkata';
  v_res := v_res || jsonb_build_array(case when v_num = v_stockc then 'PASS T64c sector totals add up to the non-cancelled order total (' || v_num || ')' else 'FAIL T64c ' || v_num || ' vs ' || v_stockc end);
  begin
    perform public.sales_report(v_today, v_today - 1, 'day');
    v_res := v_res || jsonb_build_array('FAIL T64d reversed dates accepted');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T64d sales_report refuses a reversed range');
  end;
  v_json := public.receivables_trend(4);
  v_res := v_res || jsonb_build_array(case when jsonb_array_length(v_json) = 4 and (v_json -> 3) ? 'open' and (v_json -> 3) ? 'overdue' and (v_json -> 3 ->> 'open')::numeric >= (v_json -> 3 ->> 'overdue')::numeric
    then 'PASS T64e receivables_trend returns one row per week, open ≥ overdue' else 'FAIL T64e ' || v_json::text end);
  v_stats := public.admin_dashboard_stats(v_city2);
  v_json := public.admin_dashboard_stats(null);
  v_res := v_res || jsonb_build_array(case when (v_stats ->> 'orders_today')::int <= (v_json ->> 'orders_today')::int and jsonb_array_length(v_json -> 'daily_14d') = 14 and (v_json ->> 'open_tickets') is not null
    then 'PASS T64f the dashboard narrows to a city and carries 14 days + open tickets' else 'FAIL T64f ' || v_stats::text end);
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_cm, 'role', 'authenticated')::text, true);   -- city manager of city2
  set local role authenticated;
  v_json := public.sales_report(v_today - 30, v_today + 7, 'city');
  v_res := v_res || jsonb_build_array(case when not exists (select 1 from jsonb_array_elements(v_json) x where x ->> 'key' = v_city::text)
    then 'PASS T64g a city manager''s report never shows the other city' else 'FAIL T64g ' || v_json::text end);
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_pick, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.sales_report(v_today - 7, v_today, 'day');
    v_res := v_res || jsonb_build_array('FAIL T64h picker read the sales report');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T64h a picker (no reports:view) cannot run reports');
  end;
  reset role;
  -- Customer documents
  perform set_config('request.jwt.claims', json_build_object('sub', v_rc, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.set_customer_document(null, 'fssai', v_rcid::text || '/fssai.pdf');
  v_res := v_res || jsonb_build_array(case when (select fssai_doc_path from public.restaurants where id = v_rcid) = v_rcid::text || '/fssai.pdf'
    then 'PASS T64i the customer records their own FSSAI document' else 'FAIL T64i' end);
  begin
    perform public.set_customer_document(null, 'gst', 'somewhere-else/gst.pdf');
    v_res := v_res || jsonb_build_array('FAIL T64j a path outside the customer folder was accepted');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T64j a document path outside the customer''s folder is refused');
  end;
  insert into storage.objects (bucket_id, name, owner) values ('customer-documents', v_rcid::text || '/fssai.pdf', v_rc);
  begin
    insert into storage.objects (bucket_id, name, owner) values ('customer-documents', gen_random_uuid()::text || '/fssai.pdf', v_rc);
    v_res := v_res || jsonb_build_array('FAIL T64k customer uploaded into another folder');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T64k the customer can upload into their own folder only');
  end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_ra, 'role', 'authenticated')::text, true);   -- another customer
  set local role authenticated;
  select count(*) into v_n from storage.objects where bucket_id = 'customer-documents' and name like v_rcid::text || '/%';
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_num from storage.objects where bucket_id = 'customer-documents' and name like v_rcid::text || '/%';
  reset role;
  v_res := v_res || jsonb_build_array(case when v_n = 0 and v_num = 1 then 'PASS T64l another customer cannot see the document; staff with customers:view can' else 'FAIL T64l ' || v_n || '/' || v_num end);
  -- Content pages
  set local role anon;
  select count(*), count(*) filter (where not is_published) into v_n, v_num from public.content_pages;
  reset role;
  v_res := v_res || jsonb_build_array(case when v_n >= 4 and v_num = 0 then 'PASS T64m the website reads the published content pages only (' || v_n || ')' else 'FAIL T64m ' || v_n end);
  perform set_config('request.jwt.claims', json_build_object('sub', v_pick, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.content_pages set title = 'x' where slug = 'about';
  get diagnostics v_n = row_count;
  reset role;
  v_res := v_res || jsonb_build_array(case when v_n = 0 then 'PASS T64n a picker cannot edit content pages (settings:edit)' else 'FAIL T64n rows ' || v_n end);
  set local role anon;
  v_json := public.support_channels();
  reset role;
  v_res := v_res || jsonb_build_array(case when (v_json ->> 'seo_title') is not null and (v_json ->> 'name') is not null then 'PASS T64o support_channels() carries the SEO title for the home page' else 'FAIL T64o ' || v_json::text end);

  -- T65 customer organisation (migration 020)
  -- Every account got a primary outlet mirroring its address; editing the account moves the outlet and back.
  select count(*) into v_n from public.outlets p join public.restaurants r on r.id = p.restaurant_id and p.is_primary
   where p.address = r.address and p.pincode is not distinct from r.pincode and p.warehouse_id is not distinct from r.warehouse_id;
  select count(*) into v_num from public.restaurants;
  v_res := v_res || jsonb_build_array(case when v_n = v_num and v_n > 0 then 'PASS T65a every account has one primary outlet mirroring its address (' || v_n || ')' else 'FAIL T65a ' || v_n || '/' || v_num end);
  update public.restaurants set address = '9 Dock Rd, Gate 2' where id = v_rcid;
  update public.outlets set phone = '9000000010' where restaurant_id = v_rcid and is_primary;
  v_res := v_res || jsonb_build_array(case when (select address || '|' || phone from public.outlets where restaurant_id = v_rcid and is_primary) = '9 Dock Rd, Gate 2|9000000010'
      and (select phone from public.restaurants where id = v_rcid) = '9000000010'
    then 'PASS T65b account ↔ primary outlet stay in sync both ways' else 'FAIL T65b' end);
  -- Members: an invited outlet manager and an approver join v_rc's account through the sign-up trigger.
  insert into auth.users (id, aud, role, email, email_confirmed_at, raw_user_meta_data, created_at, updated_at) values
    (v_mgr,  'authenticated', 'authenticated', 'mgr@test.local',  now(), jsonb_build_object('full_name', 'Mess Manager', 'customer_user_of', v_rcid, 'customer_role', 'outlet_manager'), now(), now()),
    (v_appr, 'authenticated', 'authenticated', 'appr@test.local', now(), jsonb_build_object('full_name', 'Approving Officer', 'customer_user_of', v_rcid, 'customer_role', 'approver'), now(), now());
  v_res := v_res || jsonb_build_array(case when (select count(*) from public.customer_users where restaurant_id = v_rcid) = 3
      and (select count(*) from public.restaurants where owner_id in (v_mgr, v_appr)) = 0
    then 'PASS T65c invited members join the account (owner + manager + approver), no new account is created' else 'FAIL T65c' end);
  -- The owner adds a second outlet in another pin code; a manager scoped to it sees only its orders.
  perform set_config('request.jwt.claims', json_build_object('sub', v_rc, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_out2 := public.save_outlet(null, null, 'Officers Mess', 'Mess Road, Cantonment', '9000000011', v_city, '530001', 17.7, 83.3, 'evening');
  v_res := v_res || jsonb_build_array(case when (select warehouse_id from public.outlets where id = v_out2) = v_wh
      and (select jsonb_array_length(public.my_order_terms() -> 'outlets')) = 2 and (public.my_order_terms() ->> 'customer_role') = 'owner'
    then 'PASS T65d the owner adds an outlet; the warehouse follows its pin code; my_order_terms lists both' else 'FAIL T65d' end);
  perform public.set_customer_user(v_mgr, 'outlet_manager', v_out2);
  reset role;
  -- The manager (outlet 2) orders for their outlet: the order carries the outlet, its address and is held for approval (defence sector).
  update public.restaurants set sector_code = 'defence', needs_order_approval = null where id = v_rcid;
  update public.sectors set needs_order_approval = true, needs_po_reference = false, is_active = true where code = 'defence';
  perform set_config('request.jwt.claims', json_build_object('sub', v_mgr, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_res := v_res || jsonb_build_array(case when (select public.my_restaurant_id()) = v_rcid and (select public.my_customer_role()) = 'outlet_manager' and (select public.my_outlet_id()) = v_out2
      and (public.my_order_terms() ->> 'orders_held_for_me')::boolean and jsonb_array_length(public.my_order_terms() -> 'outlets') = 1
    then 'PASS T65e a member resolves to the account with their role and outlet scope' else 'FAIL T65e ' || coalesce((select public.my_customer_role()), 'null') end);
  v_oi := public.place_order(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 10)), 'for the mess', null, 'evening', 'cod');
  v_res := v_res || jsonb_build_array(case when (v_oi ->> 'approval_status') = 'pending' and (v_oi ->> 'outlet_id')::uuid = v_out2
      and (select delivery_address || '|' || approval_status from public.orders where id = (v_oi ->> 'id')::uuid) = 'Mess Road, Cantonment|pending'
    then 'PASS T65f an outlet manager''s order carries the outlet address and is held for approval' else 'FAIL T65f ' || v_oi::text end);
  begin
    perform public.place_order(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 10)), null, null, 'morning', 'cod', null,
                               (select id from public.outlets where restaurant_id = v_rcid and is_primary));
    v_res := v_res || jsonb_build_array('FAIL T65g manager ordered for another outlet');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T65g an outlet manager cannot order for another outlet');
  end;
  select count(*) into v_n from public.orders where restaurant_id = v_rcid;
  select count(*) into v_num from public.orders where restaurant_id = v_rcid and outlet_id = v_out2;
  v_res := v_res || jsonb_build_array(case when v_n = v_num and v_n >= 1 then 'PASS T65h the manager sees only their outlet''s orders (' || v_n || ')' else 'FAIL T65h ' || v_n || '/' || v_num end);
  begin
    perform public.approve_order((v_oi ->> 'id')::uuid, true);
    v_res := v_res || jsonb_build_array('FAIL T65i the manager approved their own order');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T65i an outlet manager cannot approve');
  end;
  reset role;
  -- The kitchen cannot confirm a held order.
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.set_order_status((v_oi ->> 'id')::uuid, 'confirmed');
    v_res := v_res || jsonb_build_array('FAIL T65j staff confirmed a held order');
  exception when others then
    v_res := v_res || jsonb_build_array(case when sqlerrm like '%waiting for the customer%' then 'PASS T65j staff cannot confirm an order still awaiting approval' else 'FAIL T65j ' || sqlerrm end);
  end;
  reset role;
  -- The approver sees every outlet, approves one order and rejects another (stock returns).
  perform set_config('request.jwt.claims', json_build_object('sub', v_appr, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_oj := public.place_order(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 10)), null, null, 'morning', 'cod', null, v_out2);
  v_res := v_res || jsonb_build_array(case when (v_oj ->> 'approval_status') = 'not_required' and (select count(*) from public.orders where restaurant_id = v_rcid) > v_num
    then 'PASS T65k an approver''s own order is not held and they see every outlet' else 'FAIL T65k ' || v_oj::text end);
  perform public.approve_order((v_oi ->> 'id')::uuid, true, 'ok');
  v_res := v_res || jsonb_build_array(case when (select approval_status || '/' || status from public.orders where id = (v_oi ->> 'id')::uuid) = 'approved/placed'
      and (select approved_by from public.orders where id = (v_oi ->> 'id')::uuid) = v_appr
    then 'PASS T65l the approver approves; the order stays placed for the kitchen' else 'FAIL T65l' end);
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.set_order_status((v_oi ->> 'id')::uuid, 'confirmed');
  v_res := v_res || jsonb_build_array(case when (select status from public.orders where id = (v_oi ->> 'id')::uuid) = 'confirmed' then 'PASS T65m once approved, staff confirm it' else 'FAIL T65m' end);
  reset role;
  -- A rejected order: place as the manager, reject as the owner → cancelled, stock back.
  perform set_config('request.jwt.claims', json_build_object('sub', v_mgr, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_oj := public.place_order(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 10)), null, null, 'morning', 'cod');
  reset role;
  select qty into v_stockc from public.warehouse_stock where warehouse_id = v_wh and product_id = v_p1;
  perform set_config('request.jwt.claims', json_build_object('sub', v_rc, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.approve_order((v_oj ->> 'id')::uuid, false, 'wrong quantity');
  reset role;
  v_res := v_res || jsonb_build_array(case when (select approval_status || '/' || status from public.orders where id = (v_oj ->> 'id')::uuid) = 'rejected/cancelled'
      and (select qty from public.warehouse_stock where warehouse_id = v_wh and product_id = v_p1) = v_stockc + 10
    then 'PASS T65n the owner rejects: the order is cancelled and its stock returns' else 'FAIL T65n' end);
  -- Another customer cannot see this account's outlets or members; staff in scope can.
  perform set_config('request.jwt.claims', json_build_object('sub', v_ra, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.outlets where restaurant_id = v_rcid;
  select count(*) into v_num from public.customer_users where restaurant_id = v_rcid;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_res := v_res || jsonb_build_array(case when v_n = 0 and v_num = 0 and (select count(*) from public.customer_users_of(v_rcid)) = 3
    then 'PASS T65o another customer sees no outlets or members of the account; staff list its members' else 'FAIL T65o ' || v_n || '/' || v_num end);
  reset role;
  update public.sectors set needs_po_reference = true where code = 'defence';   -- restore for anything after

  -- T66 ordering + (migration 021)
  reset role;
  update public.sectors set needs_order_approval = false where code = 'defence';
  update public.restaurants set sector_code = 'restaurant' where id = v_rcid;
  -- Coupons: settings:edit creates; a picker cannot; the customer previews and the order applies it once.
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.coupons (code, kind, value, min_order_value, max_discount, once_per_customer) values ('WELCOME10', 'percent', 10, 100, 50, true) returning id into v_coupon;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_pick, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.coupons (code, kind, value) values ('HACK', 'amount', 500);
    v_res := v_res || jsonb_build_array('FAIL T66a picker created a coupon');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T66a a picker cannot create coupons (settings:edit)');
  end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_rc, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_json := public.validate_coupon('welcome10', 320);
  v_res := v_res || jsonb_build_array(case when (v_json ->> 'valid')::boolean and (v_json ->> 'discount')::numeric = 32 and (v_json ->> 'code') = 'WELCOME10'
    then 'PASS T66b validate_coupon previews 10 % of the subtotal (case-insensitive code)' else 'FAIL T66b ' || v_json::text end);
  v_json := public.validate_coupon('WELCOME10', 50);
  v_res := v_res || jsonb_build_array(case when not (v_json ->> 'valid')::boolean and (v_json ->> 'reason') like 'This code needs an order%' then 'PASS T66c below the coupon''s minimum the preview says why' else 'FAIL T66c ' || v_json::text end);
  v_ok := public.place_order(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 10)), null, null, 'morning', 'cod', null, null, 'WELCOME10');
  v_res := v_res || jsonb_build_array(case when (v_ok ->> 'discount_amount')::numeric > 0
      and (select total_amount = subtotal + tax_amount + delivery_fee - discount_amount and coupon_code = 'WELCOME10' from public.orders where id = (v_ok ->> 'id')::uuid)
      and (select count(*) from public.coupon_redemptions where order_id = (v_ok ->> 'id')::uuid) = 1
    then 'PASS T66d place_order applies the coupon: total = subtotal + GST + fee − discount, redemption recorded' else 'FAIL T66d ' || v_ok::text end);
  begin
    perform public.place_order(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 10)), null, null, 'morning', 'cod', null, null, 'WELCOME10');
    v_res := v_res || jsonb_build_array('FAIL T66e once-per-customer coupon used twice');
  exception when others then
    v_res := v_res || jsonb_build_array(case when sqlerrm like '%already used%' then 'PASS T66e a once-per-customer coupon is refused the second time (and the order rolls back)' else 'FAIL T66e ' || sqlerrm end);
  end;
  -- Editing keeps the discount (re-checked on the new subtotal).
  v_json := public.edit_order((v_ok ->> 'id')::uuid, jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 20)));
  v_res := v_res || jsonb_build_array(case when (v_json ->> 'discount_amount')::numeric = (select discount_amount from public.orders where id = (v_ok ->> 'id')::uuid)
      and (v_json ->> 'discount_amount')::numeric > 0 and (select coupon_code from public.orders where id = (v_ok ->> 'id')::uuid) = 'WELCOME10'
    then 'PASS T66f editing an order keeps its coupon (discount recomputed, capped)' else 'FAIL T66f ' || v_json::text end);
  -- Standing orders: saved by the customer, placed by the daily run for tomorrow's weekday, idempotent.
  v_so := public.save_standing_order(null, 'Daily veg', jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 10)), array[0,1,2,3,4,5,6], 'morning', 'cod');
  v_res := v_res || jsonb_build_array(case when v_so is not null and (select is_active and outlet_id is not null from public.standing_orders where id = v_so) then 'PASS T66g the customer saves a standing order for every weekday' else 'FAIL T66g' end);
  begin
    perform public.save_standing_order(null, 'Bad', jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 10)), array[1], 'express');
    v_res := v_res || jsonb_build_array('FAIL T66h express standing order accepted');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T66h a standing order cannot use the express slot');
  end;
  reset role;
  set local role service_role;
  v_json := public.run_standing_orders();
  v_stats := public.run_standing_orders();
  reset role;
  v_res := v_res || jsonb_build_array(case when (v_json ->> 'placed')::int >= 1 and (v_stats ->> 'placed')::int = 0
      and (select status = 'placed' and delivery_date = v_today + 1 and placed_by = v_rc from public.orders where id = (select last_order_id from public.standing_orders where id = v_so))
    then 'PASS T66i run_standing_orders places tomorrow''s order once as the creator (second run does nothing)' else 'FAIL T66i ' || v_json::text || ' ' || v_stats::text end);
  perform set_config('request.jwt.claims', json_build_object('sub', v_pick, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.run_standing_orders();
    v_res := v_res || jsonb_build_array('FAIL T66j picker ran standing orders');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T66j run_standing_orders is service-role only');
  end;
  reset role;
  -- Quotes: staff price a basket; the customer sees it only once sent, accepts at the quoted price.
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_quote := public.save_quote(null, v_rcid, jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 10, 'unit_price', 1)), v_today + 7, 'special rate');
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_rc, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.quotes where id = (v_quote ->> 'id')::uuid;
  begin
    perform public.accept_quote((v_quote ->> 'id')::uuid);
    v_res := v_res || jsonb_build_array('FAIL T66k draft quote accepted');
  exception when others then
    v_res := v_res || jsonb_build_array(case when v_n = 0 then 'PASS T66k a draft quote is invisible to the customer and cannot be accepted' else 'FAIL T66k sees ' || v_n end);
  end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.set_quote_status((v_quote ->> 'id')::uuid, 'sent');
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_rc, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_ol := public.accept_quote((v_quote ->> 'id')::uuid, null, 'morning', 'cod');
  v_res := v_res || jsonb_build_array(case when (select unit_price from public.order_items where order_id = (v_ol ->> 'id')::uuid and product_id = v_p1) = 1
      and (select subtotal from public.orders where id = (v_ol ->> 'id')::uuid) = 10
      and (select status || '/' || accepted_order_id::text from public.quotes where id = (v_quote ->> 'id')::uuid) = 'accepted/' || (v_ol ->> 'id')
    then 'PASS T66l accepting a sent quote places the order at the quoted price (₹1 instead of the list price)' else 'FAIL T66l ' || v_ol::text end);
  begin
    perform public.accept_quote((v_quote ->> 'id')::uuid);
    v_res := v_res || jsonb_build_array('FAIL T66m quote accepted twice');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T66m a quote can be accepted only once');
  end;
  -- Spend report: my own account only, by month and by product.
  v_json := public.my_spend_report(v_today - 30, v_today + 7, 'month');
  v_stats := public.my_spend_report(v_today - 30, v_today + 7, 'product');
  select coalesce(sum(total_amount), 0) into v_num from public.orders where restaurant_id = v_rcid and status <> 'cancelled' and created_at >= (v_today - 30)::timestamp at time zone 'Asia/Kolkata';
  v_res := v_res || jsonb_build_array(case when (select sum((x ->> 'total')::numeric) from jsonb_array_elements(v_json) x) = v_num
      and exists (select 1 from jsonb_array_elements(v_stats) x where x ->> 'key' = v_p1::text and (x ->> 'quantity') is not null)
    then 'PASS T66n my_spend_report by month adds up to the account''s non-cancelled orders; by product carries quantity' else 'FAIL T66n ' || v_json::text end);
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_pick, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.my_spend_report(v_today - 7, v_today, 'month');
    v_res := v_res || jsonb_build_array('FAIL T66o staff ran the customer spend report');
  exception when others then
    v_res := v_res || jsonb_build_array('PASS T66o my_spend_report is for customer accounts only');
  end;
  reset role;

  -- Abort on purpose so no test data is ever saved. The message IS the report.
  raise exception E'SECURITY TEST REPORT (rolled back, no data kept)\n%', jsonb_pretty(v_res);
end;
$$;
