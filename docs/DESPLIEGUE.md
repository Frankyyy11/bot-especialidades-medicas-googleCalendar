# Despliegue

El bot es un servidor Node.js sin base de datos. Cualquier host que dé **HTTPS público** sirve (Meta exige HTTPS para el webhook): un VPS con Caddy o nginx, Fly.io, Railway, Render, Google Cloud Run, etc. Los pasos exactos dependen del proveedor; aquí solo lo común.

## Importante antes de elegir

- Las **sesiones y pausas viven en memoria**: use **una sola instancia** y sin escalado automático a varias. Con varias instancias, dos mensajes del mismo paciente podrían caer en instancias distintas y perder el contexto. Si se necesita escalar, implemente `SessionStore` y `HumanPauseStore` sobre Redis (están detrás de interfaces para eso).
- Reiniciar el servidor descarta las conversaciones en curso (los pacientes simplemente reciben el menú de nuevo). Las citas **no** se pierden si usa `AGENDA_PROVIDER=google` (viven en Google Calendar). Con `memory` sí se pierden: es solo para pruebas.
- Si el host "duerme" instancias inactivas, el webhook de Meta puede tardar en responder y Meta reintentará (hay deduplicación). Prefiera un plan que mantenga el proceso activo.

## Con Docker

El `Dockerfile` es multi-etapa, no necesita compilar nada nativo y corre como usuario sin privilegios.

```bash
docker build -t bot-centro-medico .
docker run -d --name bot --restart unless-stopped -p 3000:3000 --env-file .env bot-centro-medico
```

`config/centro.json` va dentro de la imagen. Para cambiarlo sin reconstruir, móntelo:

```bash
docker run ... -v /ruta/segura/centro.json:/app/config/centro.json:ro bot-centro-medico
```

Con credenciales de Google en archivo, móntelo de solo lectura y apunte `GOOGLE_SERVICE_ACCOUNT_FILE` a esa ruta dentro del contenedor, o use `GOOGLE_SERVICE_ACCOUNT_JSON`.

> Nota: el `Dockerfile` no se pudo probar en el entorno donde se escribió (sin Docker). Haga una primera construcción de prueba antes de depender de él.

## Sin Docker

```bash
npm ci
npm run build
NODE_ENV=production npm start     # variables desde el entorno o un .env
```

Use un gestor de procesos (systemd, pm2) para reiniciar ante fallos.

## HTTPS y proxy

Ponga un proxy inverso con certificado (Caddy lo hace casi automático) hacia `localhost:3000`. Rutas:

- `GET /webhook`, `POST /webhook`: Meta.
- `GET /health`: comprobación de vida (`{"ok":true,"whatsapp":true}`).

El cuerpo del webhook se lee crudo para validar la firma: el proxy no debe modificarlo.

## Variables

Las mismas de `.env.example`. En producción defina como mínimo `AGENDA_PROVIDER=google`, las credenciales de Google y las cuatro `WHATSAPP_*`. Si falta alguna `WHATSAPP_*` el servidor arranca pero el webhook responde 503 (y lo avisa en el log): revise los logs al desplegar.

## Logs

JSON por línea en stdout/stderr, con teléfonos enmascarados (`****1234`). No incluyen nombres, cédulas ni el texto de los mensajes. Mantenga `LOG_LEVEL=info`.
