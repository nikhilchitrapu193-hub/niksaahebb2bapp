-- =============================================================================
-- Security & business-rule regression test
--
-- HOW TO RUN: paste into the Supabase SQL Editor and click Run (or run with
-- psql). It creates throw-away users, impersonates each role, checks 174
-- rules, then ABORTS ON PURPOSE so nothing is saved. The "error" you get back
-- is the report: every line should start with PASS.
--
-- Run this after ANY change to RLS policies or the functions in migrations.
-- Requires the seed catalogue (seed.sql: categories and products). The sample quotes,
-- benchmarks and stock in seed.sql are NOT needed; the test creates what it checks.
--
-- Roles simulated: admin (super admin), restaurant A (approved), restaurant B
-- (pending), delivery driver, a sign-up attempting to inject role=admin, and
-- from T20 on: a city manager of another city, a picker, and a defence unit;
-- from T30 on (migration 009): a pricing manager; from T40 on (migration 010): price lists and packing; from T44 on (migration 011): a buyer, POs and receipts.
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
begin
  select id into v_city from public.cities where name = 'Visakhapatnam';
  select id into v_wh from public.warehouses where city_id = v_city and is_default;
  -- Pin code 530001 is served by the Vizag warehouse (seed.sql adds it too); sign-ups below use it.
  insert into public.service_zones (warehouse_id, pincode, area_name) values (v_wh, '530001', 'Test area')
  on conflict (pincode) do nothing;

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
  perform public.set_order_payment((v_o1 ->> 'id')::uuid, 'paid');
  select payment_status::text into v_txt from public.orders where id = (v_o1 ->> 'id')::uuid;
  v_res := v_res || jsonb_build_array(case when v_txt = 'paid' then 'PASS T12l admin marked order paid' else 'FAIL T12l payment ' || v_txt end);
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
    perform public.set_order_payment((v_o3 ->> 'id')::uuid, 'paid');
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

  -- Abort on purpose so no test data is ever saved. The message IS the report.
  raise exception E'SECURITY TEST REPORT (rolled back, no data kept)\n%', jsonb_pretty(v_res);
end;
$$;
