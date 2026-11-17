const express = require('express')
const cors = require('cors')
const compression = require('compression')
const { PORT, CORS_ORIGINS } = require('./config')

const app = express()
app.disable('x-powered-by')
app.set('trust proxy', 1)
app.use(cors({ origin: CORS_ORIGINS, exposedHeaders: ['X-Total-Count'] }))
app.use(compression({ threshold: 1024 }))
app.use(express.json({ limit: '5mb' })) // logos y fotos en base64

app.get('/', (req, res) => res.send({ name: 'API TillDash+', status: 'ok' }))
app.get('/health', (req, res) => res.send({ ok: true }))

app.use(require('./routes/auth'))
app.use(require('./routes/settings'))
app.use(require('./routes/users'))
app.use(require('./routes/sites'))
app.use(require('./routes/logbook'))
app.use(require('./routes/dashboard'))
app.use(require('./routes/search'))
app.use(require('./routes/inventory'))
app.use(require('./routes/promotions'))
app.use(require('./routes/notifications'))
app.use(require('./routes/tables'))
app.use(require('./routes/orders'))
app.use(require('./routes/cash'))
app.use(require('./routes/incidents'))

app.use((req, res) => res.status(404).send({ message: 'Ruta no encontrada' }))

if (require.main === module) app.listen(PORT, () => console.log(`API TillDash+ escuchando en el puerto ${PORT}`))
module.exports = app
