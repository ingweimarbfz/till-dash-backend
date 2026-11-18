# TillDash+ · Backend

API de TillDash+: mesas, pedidos, caja, inventario y reportes para restaurantes, bares, markets, social bars y discotecas.
Express + Supabase, multi-cliente por `org_id` (misma base que QuontUp360).

## Arranque local
```bash
cp .env.example .env   # completar SUPABASE_SECRET_KEY y JWT_SECRET
npm install
npm run dev            # http://localhost:4000
npm test
```
Base de datos: proyecto Supabase `till-dash` (ref `ftawtyuyiwodmdqueuqa`). Las migraciones están en `supabase/migrations/`.
Para crear el primer establecimiento: `npm run seed -- "Mi Bar" superadmin "Clave2026*" Nombre Apellido 1065000000 bar`.

## Estructura
```
src/
  index.js        arranque de Express y registro de rutas
  config.js       variables de entorno
  db.js           cliente de Supabase (tiempo límite y reintento en lecturas)
  tenant.js       multi-cliente: filtra y agrega org_id automáticamente
  auth.js         roles, cargos, sesión JWT y middleware auth(roles)
  audit.js        bitácora del sistema
  http.js         errores, validaciones y utilidades
  routes/         auth, configuración, usuarios, sucursales y bodegas, bitácora, dashboard, buscador
supabase/migrations/   esquema de la base
scripts/seed.js        crea un establecimiento con su super administrador
```

## Roles
| Rol | Alcance |
|---|---|
| `superadmin` | Todo, incluida la apariencia del sitio (colores, logo, fuente) |
| `admin` | Todo menos la apariencia del sitio |
| `empleado` | Según sus cargos: mesero, cajero, cocina, bartender, barista, domiciliario, anfitrión, bodega |
| `cliente` | Su mesa por QR, la carta y sus pedidos (etapa 3) |

Un usuario puede tener varios perfiles (por ejemplo admin y empleado cajero) y elige con cuál entra.

## Endpoints (etapa 1: base)
| Método | Ruta | Rol |
|---|---|---|
| POST | `/login` | público |
| GET | `/configuracion/publica?org=` | público (login y carta por QR) |
| GET | `/auth/me`, POST `/auth/perfil` | todos |
| PUT | `/perfil`, GET `/perfil/firma` | todos (datos, foto, contraseña y firma digital) |
| GET | `/configuracion` | todos |
| PUT | `/configuracion` | superadmin, admin |
| PUT | `/configuracion/apariencia` | superadmin |
| GET/POST/PUT | `/usuarios` | superadmin, admin |
| GET/POST/PUT | `/sedes`, `/bodegas` | superadmin, admin (lectura: empleados) |
| GET | `/bitacora`, `/bitacora/filtros` | superadmin, admin |
| GET | `/dashboard` | todos (cifras según el rol) |
| GET | `/buscar?q=` | superadmin, admin, empleado |

## Endpoints (etapa 2: catálogo e inventario)
| Método | Ruta | Rol |
|---|---|---|
| GET/POST/PUT | `/inventario/categorias` | superadmin, admin (lectura: empleados) |
| GET/POST/PUT | `/inventario/productos`, GET `/inventario/productos/:id` | superadmin, admin (lectura: empleados) |
| GET | `/inventario/existencias`, `/inventario/bodegas`, `/inventario/resumen` | superadmin, admin, empleado |
| GET/POST | `/inventario/movimientos` (entrada, ajuste o baja de varios productos) | escritura: superadmin, admin |
| GET/POST | `/inventario/traslados` | escritura: superadmin, admin |
| GET | `/inventario/alertas` (stock bajo para los avisos tipo toast) | superadmin, admin, empleado |
| GET/POST/PUT | `/descuentos` | superadmin, admin (lectura: empleados) |
| GET/POST/PUT/DELETE | `/promociones` | superadmin, admin (lectura: empleados) |
| GET/PUT/DELETE | `/notificaciones`, `/notificaciones/bot`, `/notificaciones/canales` | superadmin, admin |

Filtros de lugar: `?sede=` (bodegas de esa sucursal) o `?bodega=`. El empleado siempre ve su sucursal.

### Stock bajo
Una bodega queda baja en un producto cuando su existencia llega al mínimo del producto o por debajo (con mínimo 0, cuando se agota).
Después de cada entrada, ajuste, baja o traslado se avisa por Telegram una sola vez por bodega y producto (`warehouse_stock.low_alerted`);
al reponer se rearma el aviso. El navegador consulta `/inventario/alertas` cada minuto para mostrar los toasts.

## Consecutivos
`select public.next_consecutive(org_id, 'orden', site_id, 'OR-')` entrega el siguiente número sin repetirse,
por establecimiento, sucursal y tipo de documento. Lo usan las órdenes, cierres de caja y traslados.

## Despliegue
`render.yaml` lista para Render. Variables: `SUPABASE_SECRET_KEY` y `CORS_ORIGIN` (URL del frontend en Vercel).

## Plan Distribuidora (TD-010): sin mesas, con domicilios y clientes
Para distribuidoras de cerveza, licores y bebidas que llevan el pedido hasta su cliente.
- `mesas` dejó de ser módulo del núcleo. Un plan sin `mesas` trabaja en modo **distribuidora** (`/plan/modulos` devuelve `mode`):
  se bloquean `/mesas`, el QR de mesa y los pedidos en mesa o barra; se vende a domicilio y para recoger.
- Módulos nuevos: `domicilios` (pedidos a domicilio, domiciliarios, bases) y `clientes` (directorio).
- Migración: `supabase/migrations/20261118000017_plan_distribuidora.sql` (crea el plan, los módulos y la tabla `customers`).

| Método | Ruta | Rol |
|---|---|---|
| GET | `/clientes?q=&zona=&ligero=1`, `/clientes/zonas`, `/clientes/:id` (pedidos, cuentas por cobrar, lo que más compra) | vendedores y domiciliario |
| POST/PUT | `/clientes`, `/clientes/:id` (activar o desactivar: solo admin) | vendedores y admin |

`POST /pedidos` acepta `customerId` (completa nombre, celular, dirección y valor del domicilio) o `saveCustomer: true`
para guardar al cliente nuevo. Al cobrar a crédito, la cuenta por cobrar toma los datos y el plazo (`credit_days`) del cliente.
