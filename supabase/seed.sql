-- =============================================================================
-- Seed data: starter catalogue (SAMPLE DATA — replace prices with your real ones)
-- Safe to re-run: it skips rows that already exist.
-- Prices, stock (200 each), GST rates and market prices are illustrative placeholders.
-- =============================================================================

insert into public.categories (name, sort_order) values
  ('Vegetables',          10),
  ('Fruits',              20),
  ('Dairy & Eggs',        30),
  ('Poultry & Meat',      40),
  ('Grains & Pulses',     50),
  ('Oils & Spices',       60),
  ('Packaged Foods',      70),
  ('Kitchen Essentials',  80)
on conflict (name) do nothing;

insert into public.products (sku, name, category_id, price, unit, min_order_qty, stock_qty, low_stock_threshold, market_price, gst_rate)
select v.sku, v.name, c.id, v.price, v.unit, v.min_qty,
       200, 20, round(v.price * 1.12, 0),
       case when v.sku like 'DAI-%' or v.sku like 'SPC-%' or v.sku like 'OIL-%' or v.sku = 'GRN-001' then 5
            when v.sku like 'PKG-%' then 12 when v.sku like 'KIT-%' then 18 else 0 end
from (values
  ('VEG-001', 'Tomato (Hybrid)',        'Vegetables',         32.00, 'kg',        5),
  ('VEG-002', 'Onion (Red)',            'Vegetables',         28.00, 'kg',       10),
  ('VEG-003', 'Potato',                 'Vegetables',         24.00, 'kg',       10),
  ('VEG-004', 'Green Chilli',           'Vegetables',         70.00, 'kg',        2),
  ('VEG-005', 'Coriander Leaves',       'Vegetables',         60.00, 'kg',        1),
  ('FRT-001', 'Banana (Robusta)',       'Fruits',             45.00, 'kg',        5),
  ('FRT-002', 'Lemon',                  'Fruits',             90.00, 'kg',        2),
  ('FRT-003', 'Papaya',                 'Fruits',             35.00, 'kg',        5),
  ('DAI-001', 'Full Cream Milk',        'Dairy & Eggs',       66.00, 'litre',    10),
  ('DAI-002', 'Paneer',                 'Dairy & Eggs',      340.00, 'kg',        2),
  ('DAI-003', 'Curd',                   'Dairy & Eggs',       80.00, 'kg',        5),
  ('DAI-004', 'Butter (500 g pack)',    'Dairy & Eggs',      285.00, 'pack',      4),
  ('DAI-005', 'Eggs (tray of 30)',      'Dairy & Eggs',      195.00, 'tray',      1),
  ('PLT-001', 'Chicken Curry Cut',      'Poultry & Meat',    210.00, 'kg',        5),
  ('PLT-002', 'Chicken Boneless',       'Poultry & Meat',    320.00, 'kg',        5),
  ('MTN-001', 'Mutton Curry Cut',       'Poultry & Meat',    780.00, 'kg',        2),
  ('GRN-001', 'Basmati Rice',           'Grains & Pulses',   110.00, 'kg',       25),
  ('GRN-002', 'Toor Dal',               'Grains & Pulses',   150.00, 'kg',       10),
  ('GRN-003', 'Wheat Atta',             'Grains & Pulses',    42.00, 'kg',       25),
  ('OIL-001', 'Sunflower Oil (15 L tin)','Oils & Spices',   1950.00, 'tin',       1),
  ('SPC-001', 'Turmeric Powder',        'Oils & Spices',     190.00, 'kg',        1),
  ('SPC-002', 'Red Chilli Powder',      'Oils & Spices',     320.00, 'kg',        1),
  ('PKG-001', 'Tomato Ketchup (5 kg)',  'Packaged Foods',    480.00, 'pouch',     1),
  ('KIT-001', 'Aluminium Foil (72 m)',  'Kitchen Essentials',420.00, 'roll',      1),
  ('KIT-002', 'Disposable Gloves (100)','Kitchen Essentials',190.00, 'pack',      2)
) as v(sku, name, category, price, unit, min_qty)
join public.categories c on c.name = v.category
on conflict (sku) do nothing;

-- One sample supplier so "Receive stock" has something to pick.
insert into public.suppliers (name, contact, phone)
select 'Sample Farms Co-op', 'Ramesh', '9000000000'
where not exists (select 1 from public.suppliers);

-- Stock is held per warehouse (migration 006). Seeded products carry their
-- 200 units in the default warehouse of the first city; products that already
-- have warehouse rows are left alone.
insert into public.warehouse_stock (warehouse_id, product_id, qty)
select w.id, p.id, p.stock_qty
from public.products p
cross join (select id from public.warehouses where is_default order by created_at limit 1) as w
where not exists (select 1 from public.warehouse_stock s where s.product_id = p.id);

-- A sample service zone so sign-ups with pin code 530001 land in the default warehouse.
insert into public.service_zones (warehouse_id, pincode, area_name)
select w.id, '530001', 'Visakhapatnam GPO'
from (select id from public.warehouses where is_default order by created_at limit 1) as w
on conflict (pincode) do nothing;

-- ---------- Pricing engine (migration 009) -----------------------------------
-- HSN codes and pack sizes for the sample products, and the starting pricing
-- variables per category (same values as the migration's backfill, which only
-- helps an install that already had the catalogue).
update public.products p
set hsn_code = v.hsn, pack_size = v.size, pack_unit = v.pu
from (values
  ('VEG-001', '0702', 1, 'kg'),  ('VEG-002', '0703', 1, 'kg'),  ('VEG-003', '0701', 1, 'kg'),
  ('VEG-004', '0709', 1, 'kg'),  ('VEG-005', '0709', 1, 'kg'),
  ('FRT-001', '0803', 1, 'kg'),  ('FRT-002', '0805', 1, 'kg'),  ('FRT-003', '0807', 1, 'kg'),
  ('DAI-001', '0401', 1, 'l'),   ('DAI-002', '0406', 1, 'kg'),  ('DAI-003', '0403', 1, 'kg'),
  ('DAI-004', '0405', 500, 'g'), ('DAI-005', '0407', 30, 'pc'),
  ('PLT-001', '0207', 1, 'kg'),  ('PLT-002', '0207', 1, 'kg'),  ('MTN-001', '0204', 1, 'kg'),
  ('GRN-001', '1006', 1, 'kg'),  ('GRN-002', '0713', 1, 'kg'),  ('GRN-003', '1101', 1, 'kg'),
  ('OIL-001', '1512', 15, 'l'),  ('SPC-001', '0910', 1, 'kg'),  ('SPC-002', '0904', 1, 'kg'),
  ('PKG-001', '2103', 5, 'kg'),  ('KIT-001', '7607', 1, 'pc'),  ('KIT-002', '4015', 100, 'pc')
) as v (sku, hsn, size, pu)
where p.sku = v.sku and p.hsn_code is null;

insert into public.pricing_rules (category_id, markup_pct, min_markup_pct, wastage_pct, rounding_step, benchmark_cap_pct, benchmark_source_id, note)
select c.id, v.markup, v.min_markup, v.wastage, v.step, v.cap, s.id, 'Starting value from the Vizag pricing research'
from (values
  ('Vegetables',         15, 8, 8,   0.5, 10, 'rythu_bazaar'),
  ('Fruits',             15, 8, 10,  0.5, 10, 'rythu_bazaar'),
  ('Dairy & Eggs',        4, 2, 2,   1,   null, 'distributor'),
  ('Poultry & Meat',     10, 5, 3,   5,   null, 'distributor'),
  ('Grains & Pulses',     5, 2, 0.5, 1,   5,  'doca'),
  ('Oils & Spices',       5, 2, 0.5, 1,   5,  'metro'),
  ('Packaged Foods',      5, 2, 0.5, 1,   5,  'metro'),
  ('Kitchen Essentials',  8, 3, 0,   1,   null, 'metro')
) as v (category, markup, min_markup, wastage, step, cap, source)
join public.categories c on c.name = v.category
left join public.benchmark_sources s on s.code = v.source
where not exists (select 1 from public.pricing_rules r where r.category_id = c.id);

-- Eggs follow the NECC rate + ₹0.30 per egg (₹9 per tray of 30); chicken sells ~70% of live weight.
insert into public.product_pricing (product_id, pricing_mode, fixed_margin_amount, rounding_step, benchmark_source_id, manual_reason)
select p.id, 'fixed_over_benchmark', 9, 1, s.id, 'NECC rate + ₹0.30 per egg'
from public.products p, public.benchmark_sources s
where p.sku = 'DAI-005' and s.code = 'necc'
on conflict (product_id) do nothing;
insert into public.product_pricing (product_id, yield_pct, manual_reason)
select p.id, 70, 'Dressing yield; confirm with the supplier'
from public.products p where p.sku in ('PLT-001', 'PLT-002')
on conflict (product_id) do nothing;

-- Sample supplier quotes (today's buying price) so the price board has a cost
-- to work from before any stock has been received. Placeholders, like the prices.
insert into public.product_pricing (product_id, supplier_quote, quote_date)
select p.id, v.cost, (now() at time zone 'Asia/Kolkata')::date
from (values ('VEG-001', 24.00), ('VEG-002', 22.00), ('VEG-003', 18.00), ('VEG-004', 55.00),
             ('FRT-001', 36.00), ('DAI-002', 300.00), ('GRN-001', 98.00), ('GRN-002', 135.00)) as v (sku, cost)
join public.products p on p.sku = v.sku
on conflict (product_id) do nothing;

-- ---------- Catalogue + (migration 010) --------------------------------------
-- Sample details: sub-categories, grade / origin, veg or non-veg, loose-weight
-- items, and one pack-size variant. The category tree itself is seeded by the
-- migration (reference data).
update public.products p
set category_id = c.id
from (values
  ('VEG-005', 'Leafy greens'), ('VEG-003', 'Root vegetables'), ('VEG-002', 'Root vegetables'),
  ('FRT-002', 'Citrus'), ('DAI-001', 'Milk & curd'), ('DAI-003', 'Milk & curd'), ('DAI-002', 'Paneer & cheese'),
  ('DAI-004', 'Butter & ghee'), ('DAI-005', 'Eggs'), ('PLT-001', 'Chicken'), ('PLT-002', 'Chicken'), ('MTN-001', 'Mutton'),
  ('GRN-001', 'Rice'), ('GRN-003', 'Atta & flours'), ('GRN-002', 'Dals & pulses'), ('OIL-001', 'Cooking oils'),
  ('SPC-001', 'Ground spices & masalas'), ('SPC-002', 'Ground spices & masalas')
) as v (sku, category) join public.categories c on c.name = v.category
where p.sku = v.sku and p.category_id <> c.id;

update public.products set grade = 'A', origin = 'Madanapalle', veg_type = 'veg', shelf_life_days = 5, storage_note = 'Cool, dry place' where sku = 'VEG-001' and grade is null;
update public.products set origin = 'Kurnool', veg_type = 'veg', shelf_life_days = 30 where sku = 'VEG-002' and origin is null;
update public.products set veg_type = 'veg', sold_by_weight = true, weight_tolerance_pct = 10, shelf_life_days = 2, storage_note = 'Keep refrigerated' where sku = 'VEG-005' and not sold_by_weight;
update public.products set veg_type = 'non_veg', sold_by_weight = true, weight_tolerance_pct = 10, shelf_life_days = 1, storage_note = 'Keep chilled, cook the same day' where sku in ('PLT-001', 'PLT-002', 'MTN-001') and not sold_by_weight;
update public.products set veg_type = 'veg' where sku like 'DAI-%' and sku <> 'DAI-005' and veg_type is null;
update public.products set veg_type = 'non_veg' where sku = 'DAI-005' and veg_type is null;

-- Basmati rice also comes as a 25 kg bag: its own SKU, price and stock, grouped under the 1 kg product.
insert into public.products (sku, name, category_id, price, unit, min_order_qty, stock_qty, low_stock_threshold, gst_rate, hsn_code, pack_size, pack_unit, parent_product_id, variant_label, veg_type)
select 'GRN-001-25', 'Basmati Rice (25 kg bag)', p.category_id, 2600, 'bag', 1, 40, 5, 5, '1006', 25, 'kg', p.id, '25 kg bag', 'veg'
from public.products p where p.sku = 'GRN-001'
on conflict (sku) do nothing;
insert into public.warehouse_stock (warehouse_id, product_id, qty)
select w.id, p.id, p.stock_qty from public.products p
cross join (select id from public.warehouses where is_default order by created_at limit 1) as w
where p.sku = 'GRN-001-25' and not exists (select 1 from public.warehouse_stock s where s.product_id = p.id);
