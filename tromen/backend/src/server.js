import Fastify from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import multipart from '@fastify/multipart'
import 'dotenv/config'

import authRoutes          from './routes/auth.js'
import userRoutes          from './routes/users.js'
import clientRoutes        from './routes/clients.js'
import routeRoutes         from './routes/routes.js'
import deliveryRoutes      from './routes/deliveries.js'
import gpsRoutes           from './routes/gps.js'
import dashboardRoutes     from './routes/dashboard.js'
import deudasRoutes        from './routes/deudas.js'
import ventasDepositoRoutes from './routes/ventas-deposito.js'
import productRoutes from './routes/products.js'
import geofenceRoutes from './routes/geofences.js'
const app = Fastify({
  logger: process.env.NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : true
})

// Plugins
await app.register(cors, {
  origin: process.env.CORS_ORIGIN?.split(',') ?? true,
  credentials: true,
})

await app.register(jwt, {
  secret: process.env.JWT_SECRET,
})

await app.register(multipart, {
  limits: { fileSize: 10 * 1024 * 1024 },
})

// Decorador de auth
app.decorate('authenticate', async (request, reply) => {
  try {
    await request.jwtVerify()
  } catch {
    reply.status(401).send({ error: 'No autorizado' })
  }
})

app.decorate('requireRole', (roles) => async (request, reply) => {
  await request.jwtVerify()
  if (!roles.includes(request.user.role)) {
    reply.status(403).send({ error: 'Sin permisos suficientes' })
  }
})

// Health check
app.get('/health', async () => ({
  status: 'ok',
  service: 'tromen-api',
  version: '1.0.0',
  timestamp: new Date().toISOString(),
}))

// Rutas de la API
app.register(authRoutes,           { prefix: '/api/auth' })
app.register(userRoutes,           { prefix: '/api/users' })
app.register(clientRoutes,         { prefix: '/api/clients' })
app.register(routeRoutes,          { prefix: '/api/routes' })
app.register(deliveryRoutes,       { prefix: '/api/deliveries' })
app.register(gpsRoutes,            { prefix: '/api/gps' })
app.register(dashboardRoutes,      { prefix: '/api/dashboard' })
app.register(deudasRoutes,         { prefix: '/api/deudas' })
app.register(ventasDepositoRoutes, { prefix: '/api/ventas-deposito' })
app.register(productRoutes, { prefix: '/api/products' })
app.register(geofenceRoutes, { prefix: '/api/geofences' })
// Error handler global
app.setErrorHandler((error, request, reply) => {
  app.log.error(error)
  const statusCode = error.statusCode ?? 500
  reply.status(statusCode).send({
    error: statusCode === 500 ? 'Error interno del servidor' : error.message,
    ...(process.env.NODE_ENV === 'development' && { stack: error.stack }),
  })
})

// Arranque
const start = async () => {
  try {
    await app.listen({
      port: parseInt(process.env.PORT ?? '3000'),
      host: process.env.HOST ?? '0.0.0.0',
    })
    console.log(`\n TROMEN API corriendo en http://localhost:${process.env.PORT ?? 3000}`)
    console.log(` Health check: http://localhost:${process.env.PORT ?? 3000}/health\n`)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()
