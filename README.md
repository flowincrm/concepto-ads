# Meta Ads Command Center — Concepto Agencia

Panel de gestión de cuentas de Meta Ads con caché en servidor.

---

## Deploy en Railway (paso a paso)

### 1. Crear cuenta en Railway
- Entrar a https://railway.app
- Registrarse con GitHub (recomendado, así el deploy es más fácil)

### 2. Subir el código a GitHub
- Crear un repositorio nuevo en https://github.com/new
  - Nombre: `concepto-ads`
  - Privado ✓ (importante)
- Subir estos archivos al repo

Si usás la terminal:
```bash
git init
git add .
git commit -m "Initial deploy"
git remote add origin https://github.com/TU_USUARIO/concepto-ads.git
git push -u origin main
```

### 3. Crear proyecto en Railway
- En Railway → "New Project" → "Deploy from GitHub repo"
- Seleccionar el repo `concepto-ads`
- Railway detecta automáticamente Node.js y hace el build

### 4. Agregar Redis
- En el proyecto Railway → "New" → "Database" → "Add Redis"
- Railway conecta Redis automáticamente y setea `REDIS_URL`

### 5. Configurar variables de entorno
En Railway → tu servicio → "Variables", agregar:

| Variable | Valor |
|----------|-------|
| `ANTHROPIC_API_KEY` | tu key de https://console.anthropic.com |
| `PANEL_SECRET` | una clave larga que elijas (ej: `concepto-agencia-2024-xyz`) |
| `CACHE_TTL` | `900` (15 minutos, podés ajustarlo) |

`REDIS_URL` y `PORT` los setea Railway automáticamente — no tocarlos.

### 6. Obtener la URL
- En Railway → tu servicio → "Settings" → "Domains" → "Generate Domain"
- Vas a obtener algo como: `concepto-ads-production.up.railway.app`

### 7. Conectar el panel
- Abrir la URL en el navegador
- Ingresar la URL completa del servidor (con `https://`)
- Ingresar el `PANEL_SECRET` que configuraste
- ¡Listo!

---

## Uso del caché

- **Primera consulta por cuenta**: 15-30 segundos (Meta Ads tarda)
- **Consultas siguientes** (dentro de 15 min): instantáneas (sirve desde Redis)
- El pie del panel indica si los datos vienen del caché o en vivo
- Redis se comparte entre todos los usuarios de la agencia

## Costos estimados

| Servicio | Costo |
|----------|-------|
| Railway (servidor Node) | Free hasta 500hs/mes, luego ~$5/mes |
| Railway Redis | Free tier incluido |
| Anthropic API | Pago por uso (~$0.003 por consulta) |

## Estructura del proyecto

```
concepto-ads/
├── server/
│   └── index.js      ← Servidor Express + caché Redis
├── client/
│   └── index.html    ← Panel React (HTML standalone)
├── package.json
├── railway.json
└── .env.example
```

## Variables de entorno disponibles

```
ANTHROPIC_API_KEY=sk-ant-...   # Obligatorio
PANEL_SECRET=...               # Obligatorio — clave de acceso al panel
REDIS_URL=redis://...          # Lo setea Railway automáticamente
PORT=3000                      # Lo setea Railway automáticamente
CACHE_TTL=900                  # Opcional, default 900 segundos
```
