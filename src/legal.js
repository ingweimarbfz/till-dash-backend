// =====================================================================
// Documentos legales de TillDash+ (normativa colombiana, como en Integra IPS):
//  · Contrato de prestación del servicio (se arma con el plan, el país y el ciclo de pago del establecimiento)
//  · Acuerdo de transmisión y tratamiento de datos personales (Ley 1581 de 2012)
//  · Términos y condiciones de uso (los acepta cada usuario)
// El contrato y el acuerdo de datos los firma el super administrador (representante legal o su delegado)
// antes de usar el sistema; el texto firmado se guarda como evidencia.
// Nota: son plantillas de referencia; se recomienda la revisión de un abogado.
// =====================================================================
const BRAND = 'TillDash+'
const VERSIONS = { contrato: '1.0', datos: '1.0', terminos: '1.0' }
const CODES = { contrato: 'TD-LEG-001', datos: 'TD-LEG-002', terminos: 'TD-LEG-003' }
const EFFECTIVE = '2026-11-17'
const TITLES = {
  contrato: 'Contrato de prestación de servicios de software como servicio (SaaS)',
  datos: 'Acuerdo de transmisión y tratamiento de datos personales',
  terminos: 'Términos y condiciones de uso'
}

const NO_CENTS = new Set(['COP', 'CLP', 'PYG', 'ARS'])
const moneyIn = (n, currency = 'COP', locale = 'es-CO') => {
  try {
    const dec = NO_CENTS.has(currency) || Number.isInteger(Number(n)) ? 0 : 2
    return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: dec, maximumFractionDigits: dec }).format(Number(n) || 0)
  } catch { return `${currency} ${n}` }
}
const fdate = (iso) => (iso ? new Intl.DateTimeFormat('es-CO', { dateStyle: 'long', timeZone: 'America/Bogota' }).format(new Date(`${String(iso).slice(0, 10)}T12:00:00`)) : 'la fecha de firma')
const v = (x, fb = '[por definir]') => (x == null || x === '' ? fb : x)
const lim = (n, one, many, fem = false) => (n === null || n === undefined ? `${many} ${fem ? 'ilimitadas' : 'ilimitados'}` : `${n} ${n === 1 ? one : many}`)

// ---------------------------------------------------------------- Contrato (se arma con el plan)
const contrato = ({ org, plan, price, country, provider, features }) => {
  const anual = org.billing_cycle === 'anual'
  const value = price ? (anual ? price.year : price.month) : null
  const included = features.filter((f) => (plan?.features || []).includes(f.key) || (org.extra_features || []).includes(f.key))
  return {
    intro: `Entre ${v(provider.legal_name)}, identificado con NIT ${v(provider.nit)}, representado legalmente por ${v(provider.legal_rep)}, con domicilio en ${v(provider.city)}, en adelante EL PROVEEDOR, y ${org.name}${org.nit ? `, identificado con NIT ${org.nit}` : ''}, con domicilio en ${v(org.city)}, representado por quien firma este documento, en adelante EL CLIENTE, se celebra el presente contrato de prestación de servicios, que se rige por las cláusulas siguientes y, en lo no previsto, por el Código de Comercio y el Código Civil colombianos.`,
    sections: [
      { title: 'Objeto', paragraphs: [`EL PROVEEDOR concede a EL CLIENTE el derecho de uso, no exclusivo e intransferible, de la plataforma ${BRAND} para la gestión de su establecimiento (mesas, pedidos, carta, caja, inventario y finanzas), en modalidad de software como servicio (SaaS), a través de internet, durante la vigencia del contrato y de acuerdo con el plan contratado. El servicio no incluye la venta del software ni la cesión de derechos de propiedad intelectual.`] },
      {
        title: 'Plan contratado y funcionalidades',
        paragraphs: [`EL CLIENTE contrata el plan ${v(plan?.name)}, con los siguientes límites: ${lim(plan?.max_sites, 'sucursal', 'sucursales', true)}, ${lim(plan?.max_admins, 'administrador', 'administradores')}, ${lim(plan?.max_employees, 'empleado', 'empleados')}, ${lim(plan?.max_tables, 'mesa', 'mesas', true)} y ${lim(plan?.max_products, 'producto', 'productos')}. Incluye las siguientes funcionalidades:`],
        items: included.map((f) => f.label)
      },
      {
        title: 'Valor y forma de pago',
        paragraphs: [
          value !== null
            ? `El valor del servicio es de ${moneyIn(value, price.currency, country?.locale)} (${price.currency}) ${anual ? 'por año, pagadero por anticipado' : 'por mes, pagadero por mes anticipado'}${anual && plan ? `, que incluye un descuento del ${String(plan.annual_discount).replace('.', ',')} % frente al pago mensual` : ''}. El valor podrá incluir los impuestos que correspondan según la ley del país de EL CLIENTE.`
            : 'El valor del servicio es el acordado por las partes en la cotización aceptada por EL CLIENTE, y podrá incluir los impuestos que correspondan.',
          'EL CLIENTE podrá pagar por transferencia o consignación bancaria, en efectivo con recibo de caja, o por los medios electrónicos que EL PROVEEDOR habilite. El servicio se activa o renueva cuando EL PROVEEDOR verifica el pago.',
          'Los precios podrán ajustarse una vez al año, informándolo a EL CLIENTE con al menos treinta (30) días de anticipación a la renovación.'
        ]
      },
      { title: 'Vigencia y renovación', paragraphs: [`El contrato inicia el ${fdate(org.start_date)} y tiene una vigencia de ${anual ? 'un (1) año' : 'un (1) mes'}${org.renewal_date ? `, con renovación el ${fdate(org.renewal_date)}` : ''}. Se renueva automáticamente por periodos iguales si ninguna de las partes manifiesta por escrito su intención de no renovarlo con al menos quince (15) días de anticipación al vencimiento.${plan?.trial_days && org.status === 'prueba' ? ` Los primeros ${plan.trial_days} días son de prueba sin costo.` : ''}`] },
      {
        title: 'Soporte',
        paragraphs: [`Canal de soporte del plan: ${v(plan?.support, 'WhatsApp en horario hábil')}. Horario: ${v(provider.support_hours)}. Contacto: ${v(provider.email, 'el correo que EL PROVEEDOR informe')}${provider.phone ? `, teléfono ${provider.phone}` : ''}.`],
        items: [
          'Tiempo de primera respuesta: un (1) día hábil, y cuatro (4) horas hábiles en el plan con soporte prioritario.',
          'Las fallas que impiden tomar pedidos o cobrar se atienden con prioridad, también en horario nocturno y fines de semana.',
          'El soporte cubre el uso del sistema, la corrección de fallas y la orientación a los administradores. No incluye desarrollos a la medida, la carga masiva de la carta ni capacitaciones presenciales, que se cotizan por separado.'
        ]
      },
      {
        title: 'Disponibilidad del servicio',
        paragraphs: ['EL PROVEEDOR procurará una disponibilidad mensual del 99,5 % del sistema, medida fuera de las ventanas de mantenimiento programado, que se informarán con al menos cuarenta y ocho (48) horas de anticipación y se realizarán en horas de baja operación (madrugada, de lunes a jueves).', 'No se consideran indisponibilidad las fallas causadas por la conexión a internet de EL CLIENTE, por sus equipos o impresoras, por fuerza mayor o caso fortuito, ni las interrupciones de los proveedores de infraestructura en la nube ajenas al control razonable de EL PROVEEDOR. EL PROVEEDOR realiza copias de seguridad automáticas de la base de datos.']
      },
      {
        title: 'Obligaciones de EL PROVEEDOR',
        items: ['Prestar el servicio conforme al plan contratado.', 'Mantener medidas de seguridad técnicas y administrativas razonables sobre la información.', 'Tratar los datos personales únicamente según el Acuerdo de transmisión y tratamiento de datos personales, que hace parte integral de este contrato.', 'Informar los cambios relevantes del servicio y las ventanas de mantenimiento.', 'Guardar confidencialidad sobre la información de EL CLIENTE, incluidas sus ventas, costos y finanzas.']
      },
      {
        title: 'Obligaciones de EL CLIENTE',
        items: ['Pagar oportunamente el valor del servicio.', 'Usar el sistema conforme a la ley, a este contrato y a los Términos y condiciones de uso.', 'Contar con la autorización de los titulares para el tratamiento de los datos personales que registre (empleados, clientes y socios), como responsable del tratamiento.', 'Administrar los usuarios, roles y contraseñas de su personal y retirar oportunamente el acceso de quienes se desvinculen.', 'Verificar la veracidad de la información que registra, el cuadre de sus cajas y el cumplimiento de sus obligaciones tributarias, incluida la facturación electrónica ante la autoridad de su país, que no hace parte de este servicio salvo que el plan lo indique.']
      },
      { title: 'Suspensión por falta de pago', paragraphs: ['Si EL CLIENTE no paga dentro de los diez (10) días calendario siguientes al vencimiento, EL PROVEEDOR podrá suspender el acceso, previo aviso por correo electrónico o WhatsApp. La suspensión no elimina la información, que permanece conservada y se habilita de nuevo al normalizar el pago.'] },
      {
        title: 'Terminación y destino de los datos',
        paragraphs: ['Cualquiera de las partes podrá terminar el contrato al vencimiento del periodo, con el aviso previsto en la cláusula de vigencia, o en cualquier momento por incumplimiento grave de la otra parte. El pago anual no es reembolsable una vez iniciado el periodo, salvo incumplimiento de EL PROVEEDOR.', 'A la terminación, por cualquier causa:'],
        items: [
          'EL CLIENTE tendrá treinta (30) días calendario para solicitar y descargar una copia de su información (ventas, productos, inventario, caja y finanzas) en formatos estándar como CSV o Excel.',
          'Durante ese plazo el acceso será de solo consulta y exportación.',
          'Vencido el plazo, EL PROVEEDOR eliminará de forma segura la información de EL CLIENTE de sus sistemas y de las copias de seguridad dentro de los sesenta (60) días siguientes, y expedirá una certificación de eliminación si EL CLIENTE la solicita.',
          'La conservación de los soportes contables y tributarios por el tiempo que exige la ley es responsabilidad de EL CLIENTE, por lo que debe exportarlos antes de la eliminación.'
        ]
      },
      { title: 'Propiedad intelectual', paragraphs: [`${BRAND}, su código, diseño, marca y documentación son de propiedad de EL PROVEEDOR. La información registrada por EL CLIENTE, incluidos su carta, fotos, logos y datos, es de propiedad de EL CLIENTE.`] },
      { title: 'Confidencialidad', paragraphs: ['Las partes mantendrán en reserva la información confidencial de la otra parte durante la vigencia del contrato y por cinco (5) años más, salvo requerimiento de autoridad competente.'] },
      { title: 'Limitación de responsabilidad', paragraphs: ['La responsabilidad total de EL PROVEEDOR por daños derivados del contrato se limita al valor pagado por EL CLIENTE en los doce (12) meses anteriores al hecho, salvo dolo o culpa grave. EL PROVEEDOR no responde por faltantes de caja o de inventario, ni por decisiones comerciales o tributarias que EL CLIENTE adopte con base en la información registrada.'] },
      { title: 'Firma electrónica', paragraphs: ['Las partes aceptan que este contrato se firme por medios electrónicos dentro de la plataforma, con la misma validez y fuerza obligatoria que la firma manuscrita, de conformidad con la Ley 527 de 1999 y el Decreto 2364 de 2012 (compilado en el Decreto 1074 de 2015). La plataforma conserva el texto firmado, la fecha y hora, el usuario y la dirección IP como evidencia.'] },
      { title: 'Ley aplicable y controversias', paragraphs: [`El contrato se rige por las leyes de la República de Colombia. Las controversias se resolverán primero mediante arreglo directo dentro de los treinta (30) días siguientes a la notificación de la diferencia y, en su defecto, ante los jueces competentes de ${v(provider.city)}.`] }
    ]
  }
}

// ---------------------------------------------------------------- Acuerdo de datos personales
const datos = ({ org, provider }) => ({
  intro: `Este acuerdo hace parte integral del contrato de prestación de servicios de ${BRAND} celebrado entre ${org.name}${org.nit ? ` (NIT ${org.nit})` : ''}, que actúa como RESPONSABLE del tratamiento de los datos personales, y ${v(provider.legal_name)}${provider.nit ? ` (NIT ${provider.nit})` : ''}, que actúa como ENCARGADO del tratamiento, en los términos de la Ley 1581 de 2012, el Decreto 1377 de 2013 (compilado en el Decreto 1074 de 2015) y demás normas que las modifiquen o complementen. Por tratarse de una transmisión de datos, este documento constituye el contrato de transmisión previsto en el artículo 2.2.2.25.5.2 del Decreto 1074 de 2015.`,
  sections: [
    { title: 'Datos objeto del tratamiento', items: ['Datos de los empleados y usuarios del sistema: identificación, nombre, contacto, cargo, sucursal, foto, firma digital, propinas recibidas y registros de actividad.', 'Datos de los clientes del establecimiento que se registren: nombre, teléfono, dirección de domicilio y cuentas por cobrar a su nombre, y el nombre que escriban al pedir por el QR de la mesa.', 'Datos de los socios: identificación, contacto, porcentaje de participación, aportes, utilidades y retiros.', 'Datos de proveedores del establecimiento que aparezcan en los gastos y compras.'] },
    { title: 'Finalidad', paragraphs: ['El ENCARGADO tratará los datos únicamente para prestar el servicio contratado: almacenarlos, procesarlos, mostrarlos a los usuarios autorizados del RESPONSABLE, enviar los avisos que este configure (por ejemplo, por Telegram), generar reportes, hacer copias de seguridad y brindar soporte. No los usará para fines propios, comerciales o publicitarios, ni los venderá o cederá a terceros.'] },
    { title: 'Obligaciones del RESPONSABLE', items: ['Obtener y conservar la autorización previa, expresa e informada de los titulares, salvo las excepciones legales.', 'Contar con su política de tratamiento de datos e informarla a los titulares, incluidos los clientes que piden por el QR.', 'Atender las consultas y reclamos de los titulares, con el apoyo del ENCARGADO cuando se requiera.', 'Registrar sus bases de datos en el Registro Nacional de Bases de Datos (RNBD) cuando esté obligado.', 'Dar acceso a cada empleado solo a la información que necesita para su cargo.'] },
    { title: 'Obligaciones del ENCARGADO (artículo 18 de la Ley 1581 de 2012)', items: ['Tratar los datos solo conforme a las instrucciones del RESPONSABLE y a este acuerdo.', 'Garantizar a los titulares, a través del RESPONSABLE, el ejercicio de sus derechos de conocer, actualizar, rectificar y suprimir sus datos.', 'Conservar la información con medidas de seguridad que impidan su adulteración, pérdida, consulta, uso o acceso no autorizado: cifrado en tránsito (HTTPS), control de acceso por usuario, rol, cargo y sucursal, contraseñas cifradas, separación de la información de cada establecimiento, copias de seguridad y bitácora de acciones.', 'Guardar confidencialidad y exigirla a su personal y a los subencargados.', 'Informar al RESPONSABLE cualquier violación de seguridad que afecte los datos dentro de las setenta y dos (72) horas siguientes a su conocimiento, para que este evalúe el reporte a la Superintendencia de Industria y Comercio.', 'Abstenerse de circular información que esté siendo controvertida por el titular.'] },
    { title: 'Subencargados y transferencia internacional', paragraphs: [`Para prestar el servicio el ENCARGADO utiliza los siguientes proveedores de infraestructura en la nube: ${v(provider.hosting)}. Algunos de ellos almacenan o procesan la información fuera de Colombia, en países que cuentan con niveles adecuados de protección o bajo cláusulas contractuales que garantizan la seguridad de los datos. El RESPONSABLE autoriza esta transmisión internacional, y el ENCARGADO le informará cualquier cambio de subencargado con al menos treinta (30) días de anticipación.`] },
    { title: 'Devolución y supresión', paragraphs: ['Al terminar el contrato, el ENCARGADO pondrá los datos a disposición del RESPONSABLE para su descarga durante treinta (30) días y luego los suprimirá de forma segura, incluidas las copias de seguridad, dentro de los sesenta (60) días siguientes, salvo que una norma exija conservarlos. Expedirá certificación de supresión si se le solicita.'] },
    { title: 'Auditoría', paragraphs: ['El RESPONSABLE podrá solicitar, una vez al año y con aviso de quince (15) días, información sobre las medidas de seguridad aplicadas. El ENCARGADO la entregará por escrito sin comprometer la seguridad de otros clientes.'] },
    { title: 'Contacto y vigencia', paragraphs: [`Las solicitudes relacionadas con datos personales se dirigen al correo ${v(provider.privacy_email || provider.email, 'que informe el ENCARGADO')}. Este acuerdo tiene la misma vigencia del contrato principal y sus obligaciones de confidencialidad y supresión continúan después de su terminación.`] }
  ]
})

// ---------------------------------------------------------------- Términos y condiciones (cada usuario)
const terminos = ({ org, provider }) => ({
  intro: `Estos términos regulan el uso de ${BRAND} por parte de los usuarios a quienes ${org?.name || 'el establecimiento cliente'} crea una cuenta. Al marcar "Acepto" el usuario declara haberlos leído y aceptado.`,
  sections: [
    { title: 'Cuenta y acceso', items: ['La cuenta es personal e intransferible. No compartas tu usuario ni tu contraseña, ni dejes tu sesión abierta en un equipo compartido de la caja.', 'Eres responsable de las acciones realizadas con tu cuenta: pedidos, cortesías, descuentos, cobros, gastos y movimientos de inventario. Si sospechas un uso no autorizado, avisa de inmediato al administrador.', 'Solo puedes acceder a las pantallas y sucursales que el administrador te habilite según tu cargo.'] },
    { title: 'Uso adecuado', items: ['Usa el sistema únicamente para las funciones propias de tu cargo en el establecimiento.', 'Registra la información de forma veraz y oportuna: cada pedido, cada pago y cada gasto en el momento en que ocurre.', 'Las cortesías, descuentos y anulaciones quedan a tu nombre con su motivo; úsalos solo con autorización.', 'No intentes acceder a información de otras sucursales o establecimientos sin autorización, ni vulnerar la seguridad del sistema.'] },
    { title: 'Caja y dinero', paragraphs: ['Al abrir o cerrar un turno de caja declaras que los valores registrados corresponden al efectivo real. Las diferencias del arqueo, las propinas pagadas y los gastos del turno quedan registrados con tu usuario, la fecha y la hora.'] },
    { title: 'Datos personales y reserva', paragraphs: [`La información que consultas incluye datos personales de compañeros, clientes y socios, y datos financieros del establecimiento. Debes tratarla con reserva, solo para los fines autorizados y conforme a la Ley 1581 de 2012 y a la política de tratamiento de datos de ${org?.name || 'tu establecimiento'}. Tus propios datos como usuario (nombre, identificación, contacto, firma y registros de actividad) se tratan para gestionar tu acceso, liquidar tus propinas, firmar documentos y garantizar la trazabilidad.`] },
    { title: 'Firma digital', paragraphs: ['La firma que registras en "Mi perfil" se estampa en los documentos que firmes dentro del sistema, junto con tu nombre, identificación, fecha y hora. Al firmar declaras que revisaste el documento y que su contenido es correcto. Esta firma electrónica tiene validez conforme a la Ley 527 de 1999.'] },
    { title: 'Disponibilidad y cambios', paragraphs: [`El servicio se presta por internet y puede tener interrupciones por mantenimiento o causas externas. ${BRAND} puede mejorar o modificar funcionalidades; los cambios relevantes de estos términos se informarán y deberán aceptarse de nuevo.`] },
    { title: 'Propiedad intelectual', paragraphs: [`El software, el diseño y la marca ${BRAND} son de su titular. La información registrada pertenece al establecimiento.`] },
    { title: 'Incumplimiento', paragraphs: ['El incumplimiento de estos términos puede dar lugar a la suspensión de la cuenta por parte del administrador del establecimiento, sin perjuicio de las acciones disciplinarias o legales que correspondan.'] },
    { title: 'Ley aplicable y contacto', paragraphs: [`Estos términos se rigen por la ley colombiana. Dudas sobre el sistema: ${v(provider.email, 'el administrador de tu establecimiento')}.`] }
  ]
})

const RENDER = { contrato, datos, terminos }

module.exports = { BRAND, VERSIONS, CODES, TITLES, EFFECTIVE, RENDER, moneyIn }
