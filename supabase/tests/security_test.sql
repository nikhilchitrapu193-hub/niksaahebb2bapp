-- =============================================================================
-- Security & business-rule regression test
--
-- HOW TO RUN: paste into the Supabase SQL Editor and click Run (or run with
-- psql). It creates throw-away users, impersonates each role, checks 40+
-- rules, then ABORTS ON PURPOSE so nothing is saved. The "error" you get back
-- is the report: every line should start with PASS.
--
-- Run this after ANY change to RLS policies or the functions in migrations.
-- Requires the seed catalogue (seed.sql) to be loaded.
--
-- Roles simulated: admin, restaurant A (approved), restaurant B (pending),
-- delivery driver, and a sign-up attempting to inject role=admin.
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
begin
  select id into v_p1 from public.products where sku = 'VEG-001';  -- Tomato, 32, min 5
  select id into v_p2 from public.products where sku = 'DAI-002';  -- Paneer, 340, min 2
  select id into v_p3 from public.products where sku = 'VEG-005';  -- Coriander (made out of stock)

  insert into auth.users (id, aud, role, email, email_confirmed_at, raw_user_meta_data, created_at, updated_at) values
    (v_admin, 'authenticated', 'authenticated', 'admin@test.local', now(), '{}'::jsonb, now(), now()),
    (v_ra,    'authenticated', 'authenticated', 'ra@test.local',    now(), '{"restaurant_name":"Test Kitchen A","address":"12 Road, Hyderabad","phone":"9000000001","full_name":"Owner A"}'::jsonb, now(), now()),
    (v_rb,    'authenticated', 'authenticated', 'rb@test.local',    now(), '{"restaurant_name":"Test Kitchen B","address":"34 Lane, Hyderabad"}'::jsonb, now(), now()),
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
  v_res := v_res || jsonb_build_array(case when (v_o1 ->> 'total_amount')::numeric = 1194 then 'PASS T4a total 1194 = 15x32 + 2x340 + 5% GST on paneer (client price ignored, duplicates merged)' else 'FAIL T4a total ' || (v_o1 ->> 'total_amount') end);
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
  update public.restaurants set status = 'approved' where owner_id = v_rb;
  get diagnostics v_n = row_count;
  v_res := v_res || jsonb_build_array(case when v_n = 1 then 'PASS T12g admin can approve restaurants' else 'FAIL T12g rows ' || v_n end);
  perform public.receive_stock(jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 50, 'unit_cost', 20)), null, 'GRN test');
  select stock_qty into v_num from public.products where id = v_p1;
  v_res := v_res || jsonb_build_array(case when v_num = v_stock1 + 35 then 'PASS T12h receive_stock added 50 (now ' || v_num || ')' else 'FAIL T12h stock ' || v_num end);
  perform public.adjust_stock(v_p1, v_stock1, 'wastage', '5 kg spoiled');
  select stock_qty into v_num from public.products where id = v_p1;
  v_res := v_res || jsonb_build_array(case when v_num = v_stock1 then 'PASS T12i adjust_stock set exact count' else 'FAIL T12i stock ' || v_num end);
  select count(*) into v_n from public.stock_movements where product_id = v_p1;
  v_res := v_res || jsonb_build_array(case when v_n = 4 then 'PASS T12j ledger has 4 movements (order, cancel, receive, wastage)' else 'FAIL T12j ledger rows ' || v_n end);
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
  v_res := v_res || jsonb_build_array(case when (v_stats ->> 'revenue_today')::numeric = 1194 and (v_stats ->> 'orders_today')::int = 2
                                           then 'PASS T16 dashboard: 2 orders today, revenue 1194 (cancelled excluded)'
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

  -- Abort on purpose so no test data is ever saved. The message IS the report.
  raise exception E'SECURITY TEST REPORT (rolled back, no data kept)\n%', jsonb_pretty(v_res);
end;
$$;
