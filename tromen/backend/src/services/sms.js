import twilio from 'twilio'

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
)

const FROM = process.env.TWILIO_PHONE_NUMBER

function formatPhone(phone) {
  if (!phone) return null
  const clean = phone.replace(/\D/g, '')
  // Ya tiene código de país completo
  if (clean.startsWith('549') && clean.length === 13) return `+${clean}`
  if (clean.startsWith('54') && clean.length === 12) return `+${clean}`
  // Número argentino con 9 de celular (11 dígitos)
  if (clean.startsWith('9') && clean.length === 11) return `+54${clean}`
  // Número argentino sin 9 (10 dígitos) — agregar 9
  if (clean.length === 10) return `+549${clean}`
  // Número con 0 adelante
  if (clean.startsWith('0') && clean.length === 11) return `+549${clean.slice(1)}`
  return `+549${clean}`
}

export async function sendSMSEntrega({ clientName, phone, items, total, method, creditAmount, notes }) {
  const numero = formatPhone(phone)
  if (!numero) return { ok: false, error: 'Sin número de teléfono' }

  const METODO = {
    efectivo: 'Efectivo',
    transferencia: 'Transferencia',
    cuenta_corriente: 'Cuenta corriente',
    mixto: 'Mixto',
  }

  const itemsTexto = items
    .filter(i => i.qty > 0)
    .map(i => `  - ${i.name} x${i.qty}: $${(i.qty * i.price).toLocaleString('es-AR')}`)
    .join('\n')

  let mensaje = `Distribuidora TROMEN - Catriel\n`
  mensaje += `Hola ${clientName}!\n\n`
  mensaje += `Detalle de su compra:\n${itemsTexto}\n\n`
  mensaje += `Total: $${Number(total).toLocaleString('es-AR')}\n`
  mensaje += `Pago: ${METODO[method] ?? method}`

  if (creditAmount > 0) {
    mensaje += `\nSaldo pendiente: $${Number(creditAmount).toLocaleString('es-AR')}`
  }

  if (notes) {
    mensaje += `\nNotas: ${notes}`
  }

  mensaje += `\n\nGracias por su compra!\nContacto: (299) 4XX-XXXX`

  try {
    await client.messages.create({
      body: mensaje,
      from: FROM,
      to: numero,
    })
    return { ok: true }
  } catch (err) {
    console.error('Error SMS Twilio:', err.message)
    return { ok: false, error: err.message }
  }
}
