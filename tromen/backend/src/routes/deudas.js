import sql from '../db/connection.js'

export default async function deudasRoutes(app) {

  // GET /api/deudas — lista de todos los clientes con saldo pendiente
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

  // GET /api/deudas/:clientId — historial de cuenta corriente de un cliente
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

  // POST /api/deudas/:clientId/pago — registrar pago parcial de deuda
  app.post('/:clientId/pago', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['monto'],
        properties: {
          monto:  { type: 'number', minimum: 0.01 },
          metodo: { type: 'string', enum: ['efectivo', 'transferencia'] },
          nota:   { type: 'string' },
        }
      }
    }
  }, async (request, reply) => {
    const { clientId } = request.params
    const { monto, metodo = 'efectivo', nota } = request.body

    const [client] = await sql`SELECT id, balance FROM clients WHERE id = ${clientId}`
    if (!client) return reply.status(404).send({ error: 'Cliente no encontrado' })

    const deudaActual = parseFloat(client.balance)
    if (deudaActual <= 0) {
      return reply.status(400).send({ error: 'Este cliente no tiene deuda pendiente' })
    }
    if (monto > deudaActual) {
      return reply.status(400).send({ error: `El monto ($${monto}) supera la deuda total ($${deudaActual.toFixed(2)})` })
    }

    // Descontar de las entregas más antiguas primero
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

    // Actualizar balance del cliente
    await sql`
      UPDATE clients
      SET balance = GREATEST(0, balance - ${monto})
      WHERE id = ${clientId}
    `

    // Registrar en pagos_cuenta_corriente
    await sql`
      INSERT INTO pagos_cuenta_corriente
        (client_id, monto, metodo, nota, registrado_por)
      VALUES
        (${clientId}, ${monto}, ${metodo}, ${nota ?? null}, ${request.user.id})
    `

    return {
      ok: true,
      aplicado: monto,
      mensaje: `Se aplicaron $${monto.toFixed(2)} a la deuda del cliente`
    }
  })
}
