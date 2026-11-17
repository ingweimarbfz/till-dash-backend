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

## Endpoints (etapa 1)
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

## Consecutivos
`select public.next_consecutive(org_id, 'orden', site_id, 'OR-')` entrega el siguiente número sin repetirse,
por establecimiento, sucursal y tipo de documento. Lo usan las órdenes, cierres de caja y traslados.

## Despliegue
`render.yaml` lista para Render. Variables: `SUPABASE_SECRET_KEY` y `CORS_ORIGIN` (URL del frontend en Vercel).
