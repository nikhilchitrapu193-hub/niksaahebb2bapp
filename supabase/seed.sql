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
