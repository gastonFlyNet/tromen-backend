import sql from '../db/connection.js'

export default async function deudasRoutes(app) {

  // GET /api/deudas - lista de todos los clientes con saldo pendiente
  app.get('/', {
    preHandler: [app.authenticate]
  }, async () => {
    const rows = await sql`
      SELECT
        id          AS client_id,
        name,
        address,
        phone,
        balance     AS total_deuda
      FROM clients
      WHERE balance > 0
        AND active = true
      ORDER BY balance DESC
    `
    return { deudas: rows }
  })

  // GET /api/deudas/:clientId - historial de cuenta corriente de un cliente
  app.get('/:clientId', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    const { clientId } = request.params

    const [client] = await sql`SELECT id FROM clients WHERE id = ${clientId}`
    if (!client) return reply.status(404).send({ error: 'Cliente no encontrado' })

    const historial = await sql`
      SELECT
        d.id,
        d.credit_amount,
        d.actual_amount      AS total_amount,
        d.payment_method,
        d.notes,
        d.created_at,
        r.route_date
      FROM deliveries d
      JOIN routes r ON r.id = d.route_id
      WHERE d.client_id = ${clientId}
        AND d.credit_amount > 0
      ORDER BY d.created_at DESC
    `
    return { historial }
  })

  // POST /api/deudas/:clientId/pago - registrar pago parcial de deuda
  // Idempotente: si viene client_uuid y ya se proceso, devuelve OK sin duplicar.
  // Todo el trabajo va en una transaccion (o se aplica todo, o nada).
  app.post('/:clientId/pago', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['monto'],
        properties: {
          monto:       { type: 'number', minimum: 0.01 },
          metodo:      { type: 'string', enum: ['efectivo', 'transferencia'] },
          nota:        { type: 'string' },
          client_uuid: { type: 'string' },
        }
      }
    }
  }, async (request, reply) => {
    const { clientId } = request.params
    const { monto, metodo = 'efectivo', nota, client_uuid = null } = request.body

    const resultado = await sql.begin(async (sql) => {
      // 1. PORTERO DE IDEMPOTENCIA
      // Si viene client_uuid, intentamos reclamar el registro del pago primero.
      // Si ya existia (ON CONFLICT DO NOTHING no devuelve fila), es un reintento:
      // no descontamos nada y salimos con duplicado=true.
      if (client_uuid) {
        const insertado = await sql`
          INSERT INTO pagos_cuenta_corriente
            (client_id, monto, metodo, nota, registrado_por, client_uuid)
          VALUES
            (${clientId}, ${monto}, ${metodo}, ${nota ?? null}, ${request.user.id}, ${client_uuid})
          ON CONFLICT (client_uuid) DO NOTHING
          RETURNING id
        `
        if (insertado.length === 0) {
          // Ya estaba: pago ya aplicado en un envio anterior. Idempotente.
          return { duplicado: true }
        }
      }

      // 2. Validaciones (despues del portero, para que un reintento no falle
      //    por "la deuda ya bajo").
      const [client] = await sql`SELECT id, balance FROM clients WHERE id = ${clientId}`
      if (!client) {
        return { error: 404, mensaje: 'Cliente no encontrado' }
      }

      const deudaActual = parseFloat(client.balance)
      if (deudaActual <= 0) {
        return { error: 400, mensaje: 'Este cliente no tiene deuda pendiente' }
      }
      if (monto > deudaActual) {
        return { error: 400, mensaje: `El monto ($${monto}) supera la deuda total ($${deudaActual.toFixed(2)})` }
      }

      // 3. Descontar de las entregas mas antiguas primero
      const entregas = await sql`
        SELECT id, credit_amount
        FROM deliveries
        WHERE client_id = ${clientId}
          AND credit_amount > 0
        ORDER BY created_at ASC
      `

      let resto = monto
      for (const entrega of entregas) {
        if (resto <= 0) break
        const deuda = parseFloat(entrega.credit_amount)
        const pagar = Math.min(deuda, resto)
        const nuevo = parseFloat((deuda - pagar).toFixed(2))
        await sql`UPDATE deliveries SET credit_amount = ${nuevo} WHERE id = ${entrega.id}`
        resto = parseFloat((resto - pagar).toFixed(2))
      }

      // 4. Actualizar balance del cliente
      await sql`
        UPDATE clients
        SET balance = GREATEST(0, balance - ${monto})
        WHERE id = ${clientId}
      `

      // 5. Si NO vino client_uuid (cobro online clasico), recien aca insertamos
      //    el pago. Si vino, ya lo insertamos en el paso 1 (portero).
      if (!client_uuid) {
        await sql`
          INSERT INTO pagos_cuenta_corriente
            (client_id, monto, metodo, nota, registrado_por)
          VALUES
            (${clientId}, ${monto}, ${metodo}, ${nota ?? null}, ${request.user.id})
        `
      }

      return { ok: true }
    })

    // Manejo de los resultados de la transaccion
    if (resultado.duplicado) {
      return {
        ok: true,
        duplicado: true,
        aplicado: monto,
        mensaje: 'Pago ya registrado previamente (idempotente)'
      }
    }

    if (resultado.error) {
      return reply.status(resultado.error).send({ error: resultado.mensaje })
    }

    return {
      ok: true,
      aplicado: monto,
      mensaje: `Se aplicaron $${monto.toFixed(2)} a la deuda del cliente`
    }
  })
}

