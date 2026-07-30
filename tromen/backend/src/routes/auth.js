import crypto from 'crypto'
import bcrypt from 'bcrypt'
import sql from '../db/connection.js'

// Genera un refresh token opaco (random), guarda su hash en la DB, devuelve el token en claro.
async function crearRefreshToken(user_id, deviceInfo = null) {
  const raw = crypto.randomBytes(64).toString('hex')          // token en claro (va al cliente)
  const hash = crypto.createHash('sha256').update(raw).digest('hex')  // hash (va a la DB)
  const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)   // 90 días
  await sql`
    INSERT INTO refresh_tokens (user_id, token_hash, expires_at, device_info)
    VALUES (${user_id}, ${hash}, ${expiresAt}, ${deviceInfo})
  `
  return raw
}

export default async function authRoutes(app) {

  // POST /api/auth/login
  app.post('/login', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email:    { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 6 },
        }
      }
    }
  }, async (request, reply) => {
    const { email, password } = request.body

    const [user] = await sql`
      SELECT id, name, email, phone, role, password_hash, avatar_url, active, app_access
      FROM users
      WHERE email = ${email.toLowerCase()}
      LIMIT 1
    `

    if (!user) {
      return reply.status(401).send({ error: 'Credenciales inválidas' })
    }

    if (!user.active) {
      return reply.status(403).send({ error: 'Usuario inactivo. Contactá al administrador.' })
    }

    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) {
      return reply.status(401).send({ error: 'Credenciales inválidas' })
    }

    await sql`UPDATE users SET last_login_at = NOW() WHERE id = ${user.id}`

    const token = app.jwt.sign(
      {
        id:    user.id,
        email: user.email,
        role:  user.role,
        name:  user.name,
      },
      { expiresIn: process.env.JWT_EXPIRES_IN ?? '1h' }
    )

    const refresh_token = await crearRefreshToken(user.id, request.headers['user-agent'] ?? null)

    return {
      token,
      refresh_token,
      user: {
        id:         user.id,
        name:       user.name,
        email:      user.email,
        phone:      user.phone,
        role:       user.role,
        avatarUrl:  user.avatar_url,
        app_access: user.app_access ?? true,
      }
    }
  })

  // GET /api/auth/me
  app.get('/me', {
    preHandler: [app.authenticate]
  }, async (request) => {
    const [user] = await sql`
      SELECT id, name, email, phone, role, avatar_url, app_access, last_login_at, created_at
      FROM users
      WHERE id = ${request.user.id}
    `
    return user
  })

  // POST /api/auth/change-password
  app.post('/change-password', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['currentPassword', 'newPassword'],
        properties: {
          currentPassword: { type: 'string', minLength: 6 },
          newPassword:     { type: 'string', minLength: 6 },
        }
      }
    }
  }, async (request, reply) => {
    const { currentPassword, newPassword } = request.body

    const [user] = await sql`
      SELECT password_hash FROM users WHERE id = ${request.user.id}
    `

    const valid = await bcrypt.compare(currentPassword, user.password_hash)
    if (!valid) {
      return reply.status(400).send({ error: 'Contraseña actual incorrecta' })
    }

    const newHash = await bcrypt.hash(newPassword, 10)
    await sql`UPDATE users SET password_hash = ${newHash} WHERE id = ${request.user.id}`

    return { message: 'Contraseña actualizada correctamente' }
  })

  // POST /api/auth/refresh
  app.post('/refresh', {
    schema: {
      body: {
        type: 'object',
        required: ['refresh_token'],
        properties: {
          refresh_token: { type: 'string' },
        }
      }
    }
  }, async (request, reply) => {
    const { refresh_token } = request.body
    const hash = crypto.createHash('sha256').update(refresh_token).digest('hex')

    const [stored] = await sql`
      SELECT * FROM refresh_tokens WHERE token_hash = ${hash} LIMIT 1
    `

    if (!stored || stored.revoked || new Date(stored.expires_at) < new Date()) {
      return reply.status(401).send({ error: 'Refresh token inválido' })
    }

    const [user] = await sql`
      SELECT id, email, role, name, active FROM users WHERE id = ${stored.user_id}
    `

    if (!user || !user.active) {
      return reply.status(401).send({ error: 'Refresh token inválido' })
    }

    const token = app.jwt.sign(
      {
        id:    user.id,
        email: user.email,
        role:  user.role,
        name:  user.name,
      },
      { expiresIn: process.env.JWT_EXPIRES_IN ?? '1h' }
    )

    return { token }
  })

  // POST /api/auth/logout
  app.post('/logout', {
    schema: {
      body: {
        type: 'object',
        required: ['refresh_token'],
        properties: {
          refresh_token: { type: 'string' },
        }
      }
    }
  }, async (request) => {
    const { refresh_token } = request.body
    const hash = crypto.createHash('sha256').update(refresh_token).digest('hex')

    await sql`UPDATE refresh_tokens SET revoked = true WHERE token_hash = ${hash}`

    return { ok: true }
  })
}
