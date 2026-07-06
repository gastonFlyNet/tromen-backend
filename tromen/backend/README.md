# TROMEN — Sistema de Gestión de Distribución
**BYF Soluciones** · Backend API v1.0.0

## Stack tecnológico
- **Runtime:** Node.js 20+
- **Framework:** Fastify 4
- **Base de datos:** PostgreSQL 14+
- **Auth:** JWT (RS256)
- **ORM:** postgres.js (queries tipadas, sin ORM pesado)

---

## Estructura del proyecto

```
tromen/backend/
├── migrations/
│   └── 001_schema.sql        # Schema completo de la DB
├── seeds/
│   └── 001_seed.sql          # Datos de prueba
├── src/
│   ├── db/
│   │   ├── connection.js     # Pool de conexión postgres.js
│   │   └── migrate.js        # Runner de migraciones
│   ├── middleware/
│   │   └── auth.js           # JWT + control de roles
│   ├── routes/
│   │   ├── auth.js           # Login, perfil, cambio de contraseña
│   │   ├── users.js          # CRUD usuarios
│   │   ├── clients.js        # CRUD clientes + saldos
│   │   ├── routes.js         # Hojas de ruta
│   │   ├── deliveries.js     # Entregas + evidencia + pagos
│   │   ├── gps.js            # Telemetría GPS + batch offline
│   │   └── dashboard.js      # Métricas + alertas + cobranzas
│   └── server.js             # Entry point Fastify
├── .env.example
└── package.json
```

---

## Setup rápido

### 1. Clonar e instalar

```bash
git clone https://github.com/tu-usuario/tromen-backend.git
cd tromen-backend
npm install
```

### 2. Configurar variables de entorno

```bash
cp .env.example .env
# Editar .env con tu DATABASE_URL y JWT_SECRET
```

### 3. Crear la base de datos

```bash
# Con PostgreSQL local:
createdb tromen_db

# O con psql:
psql -U postgres -c "CREATE DATABASE tromen_db;"
```

### 4. Correr migraciones + seed

```bash
npm run migrate
```

Esto crea todas las tablas, índices, vistas y carga datos de prueba.

### 5. Arrancar el servidor

```bash
npm run dev
# → http://localhost:3000
```

---

## API Reference

### Auth
| Método | Endpoint | Descripción |
|--------|----------|-------------|
| POST | `/api/auth/login` | Login → retorna JWT |
| GET | `/api/auth/me` | Perfil del usuario logueado |
| POST | `/api/auth/change-password` | Cambiar contraseña |

### Usuarios
| Método | Endpoint | Rol requerido |
|--------|----------|---------------|
| GET | `/api/users` | admin, supervisor |
| GET | `/api/users/:id` | propio o admin |
| POST | `/api/users` | admin |
| PATCH | `/api/users/:id` | propio o admin |

### Clientes
| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/clients` | Lista con filtros |
| GET | `/api/clients/:id` | Detalle + historial |
| POST | `/api/clients` | Crear cliente |
| PATCH | `/api/clients/:id` | Actualizar |
| GET | `/api/clients/report/balances` | Saldos cuenta corriente |

### Rutas
| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/routes` | Lista (admin ve todas, repartidor ve las suyas) |
| GET | `/api/routes/today` | Ruta del día + entregas del repartidor logueado |
| GET | `/api/routes/:id` | Detalle completo |
| POST | `/api/routes` | Crear ruta con paradas |
| PATCH | `/api/routes/:id/start` | Iniciar ruta |
| PATCH | `/api/routes/:id/finish` | Finalizar ruta |

### Entregas
| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/deliveries/:id` | Detalle + evidencia + pagos |
| PATCH | `/api/deliveries/:id` | Registrar resultado de entrega |
| PATCH | `/api/deliveries/:id/arrived` | Marcar llegada al cliente |
| POST | `/api/deliveries/:id/evidence` | Subir foto/firma |

### GPS
| Método | Endpoint | Descripción |
|--------|----------|-------------|
| POST | `/api/gps` | Enviar posición actual |
| POST | `/api/gps/batch` | Enviar lote offline (hasta 500 puntos) |
| GET | `/api/gps/live` | Posición en tiempo real de todos los repartidores |
| GET | `/api/gps/track/:routeId` | Track completo de una ruta |
| GET | `/api/gps/user/:userId/today` | Track del día de un usuario |

### Dashboard
| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/dashboard/today` | Resumen del día en tiempo real |
| GET | `/api/dashboard/summary?from=&to=` | Resumen por rango de fechas |
| GET | `/api/dashboard/collections` | Cobranzas pendientes de conciliar |
| GET | `/api/dashboard/alerts` | Alertas del sistema |

---

## Usuarios de prueba

| Email | Contraseña | Rol |
|-------|-----------|-----|
| admin@tromen.com | tromen2024 | admin |
| supervisor@tromen.com | tromen2024 | supervisor |
| juan@tromen.com | tromen2024 | repartidor |
| miguel@tromen.com | tromen2024 | repartidor |

---

## Deploy

### Railway (recomendado)
1. Crear proyecto en railway.app
2. Add PostgreSQL service
3. Deploy desde GitHub
4. Configurar variables de entorno

### Supabase (DB)
1. Crear proyecto en supabase.com
2. Copiar `DATABASE_URL` de Settings > Database
3. Ejecutar `001_schema.sql` en el SQL Editor de Supabase
4. Ejecutar `001_seed.sql`

---

## Próximos módulos
- [ ] App móvil React Native
- [ ] Panel web Next.js
- [ ] Integración GPS hardware
- [ ] WebSockets para tiempo real
- [ ] Sistema de notificaciones push
- [ ] Reportes PDF automáticos

---

*BYF Soluciones — 2025*
