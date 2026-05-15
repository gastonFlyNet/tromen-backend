-- ============================================================
--  TROMEN — Datos de prueba (seed)
--  Las contraseñas son hasheadas en el migrate.js
--  Password de todos los usuarios de prueba: tromen2024
-- ============================================================

-- Limpieza ordenada respetando FK
TRUNCATE geofence_events, geofences, gps_events, cash_closings,
         payments, delivery_evidence, deliveries, routes, clients, users
CASCADE;

-- ============================================================
--  USUARIOS
--  Hash de "tromen2024" generado con bcrypt rounds=10
-- ============================================================

INSERT INTO users (id, name, email, phone, password_hash, role) VALUES
(
  'a0000001-0000-0000-0000-000000000001',
  'Admin TROMEN',
  'admin@tromen.com',
  '2994100001',
  '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lHiu',
  'admin'
),
(
  'a0000002-0000-0000-0000-000000000002',
  'Carlos Supervisor',
  'supervisor@tromen.com',
  '2994100002',
  '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lHiu',
  'supervisor'
),
(
  'a0000003-0000-0000-0000-000000000003',
  'Juan Pérez',
  'juan@tromen.com',
  '2994200001',
  '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lHiu',
  'repartidor'
),
(
  'a0000004-0000-0000-0000-000000000004',
  'Miguel Torres',
  'miguel@tromen.com',
  '2994200002',
  '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lHiu',
  'repartidor'
);

-- ============================================================
--  CLIENTES
-- ============================================================

INSERT INTO clients (id, name, trade_name, address, city, zone, phone, tax_id, credit_limit, balance, latitude, longitude) VALUES
(
  'b0000001-0000-0000-0000-000000000001',
  'Almacén El Sol S.R.L.',
  'El Sol',
  'Av. Argentina 1234',
  'Neuquén',
  'Centro',
  '2994311001',
  '30-71234567-8',
  50000, 12500,
  -38.9516, -68.0591
),
(
  'b0000002-0000-0000-0000-000000000002',
  'Supermercado La Luna',
  'La Luna',
  'Ruta 22 km 5',
  'Neuquén',
  'Norte',
  '2994311002',
  '30-72345678-9',
  80000, 0,
  -38.9300, -68.0400
),
(
  'b0000003-0000-0000-0000-000000000003',
  'Kiosco Las Estrellas',
  'Las Estrellas',
  'Belgrano 567',
  'Neuquén',
  'Centro',
  '2994311003',
  '27-11112222-5',
  10000, 3200,
  -38.9540, -68.0620
),
(
  'b0000004-0000-0000-0000-000000000004',
  'Despensa Don Rubén',
  'Don Rubén',
  'San Martín 890',
  'Neuquén',
  'Sur',
  '2994311004',
  '20-33334444-1',
  20000, 0,
  -38.9700, -68.0500
),
(
  'b0000005-0000-0000-0000-000000000005',
  'Minimarket Norte',
  'Minimarket Norte',
  'Ruta 7 km 2',
  'Neuquén',
  'Norte',
  '2994311005',
  '30-55556666-7',
  35000, 8900,
  -38.9150, -68.0300
);

-- ============================================================
--  RUTA DE HOY (Juan Pérez)
-- ============================================================

INSERT INTO routes (id, user_id, route_date, status, started_at, total_stops, completed_stops, total_amount, collected_amount) VALUES
(
  'c0000001-0000-0000-0000-000000000001',
  'a0000003-0000-0000-0000-000000000003',
  CURRENT_DATE,
  'en_curso',
  NOW() - INTERVAL '2 hours',
  5, 3,
  145000, 98500
);

-- ============================================================
--  ENTREGAS de la ruta de hoy
-- ============================================================

INSERT INTO deliveries (id, route_id, client_id, stop_order, status, expected_amount, actual_amount, payment_method, cash_received, transfer_amount, credit_amount, delivered_at) VALUES
(
  'd0000001-0000-0000-0000-000000000001',
  'c0000001-0000-0000-0000-000000000001',
  'b0000001-0000-0000-0000-000000000001',
  1, 'entregado', 32000, 32000, 'efectivo', 32000, 0, 0,
  NOW() - INTERVAL '90 minutes'
),
(
  'd0000002-0000-0000-0000-000000000002',
  'c0000001-0000-0000-0000-000000000001',
  'b0000002-0000-0000-0000-000000000002',
  2, 'entregado', 45000, 45000, 'transferencia', 0, 45000, 0,
  NOW() - INTERVAL '60 minutes'
),
(
  'd0000003-0000-0000-0000-000000000003',
  'c0000001-0000-0000-0000-000000000001',
  'b0000003-0000-0000-0000-000000000003',
  3, 'entregado', 21500, 21500, 'cuenta_corriente', 0, 0, 21500,
  NOW() - INTERVAL '30 minutes'
),
(
  'd0000004-0000-0000-0000-000000000004',
  'c0000001-0000-0000-0000-000000000001',
  'b0000004-0000-0000-0000-000000000004',
  4, 'pendiente', 28000, 0, NULL, 0, 0, 0, NULL
),
(
  'd0000005-0000-0000-0000-000000000005',
  'c0000001-0000-0000-0000-000000000001',
  'b0000005-0000-0000-0000-000000000005',
  5, 'pendiente', 18500, 0, NULL, 0, 0, 0, NULL
);

-- ============================================================
--  GPS EVENTS (simulando tracking de Juan Pérez)
-- ============================================================

INSERT INTO gps_events (user_id, route_id, latitude, longitude, speed, recorded_at) VALUES
('a0000003-0000-0000-0000-000000000003', 'c0000001-0000-0000-0000-000000000001', -38.9516, -68.0591, 35.5, NOW() - INTERVAL '5 minutes'),
('a0000003-0000-0000-0000-000000000003', 'c0000001-0000-0000-0000-000000000001', -38.9520, -68.0600, 28.0, NOW() - INTERVAL '4 minutes'),
('a0000003-0000-0000-0000-000000000003', 'c0000001-0000-0000-0000-000000000001', -38.9530, -68.0610, 0.0,  NOW() - INTERVAL '3 minutes'),
('a0000003-0000-0000-0000-000000000003', 'c0000001-0000-0000-0000-000000000001', -38.9535, -68.0608, 12.0, NOW() - INTERVAL '2 minutes'),
('a0000003-0000-0000-0000-000000000003', 'c0000001-0000-0000-0000-000000000001', -38.9540, -68.0615, 40.0, NOW() - INTERVAL '1 minute');

-- ============================================================
--  GEOCERCA del depósito
-- ============================================================

INSERT INTO geofences (name, type, polygon_coords, center_lat, center_lon, radius_meters) VALUES
(
  'Depósito TROMEN Central',
  'deposito',
  '{"type":"Polygon","coordinates":[[[-68.065,-38.952],[-68.063,-38.952],[-68.063,-38.954],[-68.065,-38.954],[-68.065,-38.952]]]}',
  -38.953, -68.064, 200
),
(
  'Zona Centro Neuquén',
  'zona_entrega',
  '{"type":"Polygon","coordinates":[[[-68.070,-38.945],[-68.050,-38.945],[-68.050,-38.960],[-68.070,-38.960],[-68.070,-38.945]]]}',
  -38.952, -68.060, 1000
);
