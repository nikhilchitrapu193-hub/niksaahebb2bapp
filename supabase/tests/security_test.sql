-- =============================================================================
-- Security & business-rule regression test
--
-- HOW TO RUN: paste into the Supabase SQL Editor and click Run (or run with
-- psql). It creates throw-away users, impersonates each role, checks 86
-- rules, then ABORTS ON PURPOSE so nothing is saved. The "error" you get back
-- is the report: every line should start with PASS.
--
-- Run this after ANY change to RLS policies or the functions in migrations.
-- Requires the seed catalogue (seed.sql) to be loaded.
--
-- Roles simulated: admin (super admin), restaurant A (approved), restaurant B
-- (pending), delivery driver, a sign-up attempting to inject role=admin, and
-- from T20 on: a city manager of another city, a picker, and a defence unit.
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
  v_res := v_res || jsonb_build_array(case when v_n = 25 then 'PASS T2a anonymous visitors can browse the public catalogue' else 'FAIL T2a anon sees ' || v_n end);
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
  reset role;

  -- T3 pending restaurant B: can browse, cannot order
  perform set_config('request.jwt.claims', json_build_object('sub', v_rb, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.products;
  v_res := v_res || jsonb_build_array(case when v_n = 25 then 'PASS T3a pending restaurant can browse 25 products' else 'FAIL T3a sees ' || v_n end);
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
  v_res := v_res || jsonb_build_array(case when v_n = 2 then 'PASS T21b anonymous sees the 2 self-registering sectors' else 'FAIL T21b ' || v_n end);
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

  -- Abort on purpose so no test data is ever saved. The message IS the report.
  raise exception E'SECURITY TEST REPORT (rolled back, no data kept)\n%', jsonb_pretty(v_res);
end;
$$;
