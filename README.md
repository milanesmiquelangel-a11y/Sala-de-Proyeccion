# Sala de Proyección V4.1

Plataforma web para generar vídeos con IA a partir de texto e imágenes, utilizando Pollinations AI, con autenticación, historial de generaciones y almacenamiento persistente mediante Supabase.

## Características

- Registro e inicio de sesión con contraseña.
- Generación de vídeo mediante Pollinations AI.
- Modelos de vídeo configurables desde el servidor.
- Formatos 16:9, 9:16 y 1:1.
- Duraciones validadas por servidor.
- Imagen de referencia opcional.
- Historial privado por usuario.
- Almacenamiento de imágenes y MP4 en Supabase Storage.
- PostgreSQL/Supabase para usuarios e historial.
- URLs firmadas para recursos privados.
- Sesiones persistentes con PostgreSQL cuando `DATABASE_URL` está configurada.
- Fallback local para pruebas.
- Límite de generaciones por usuario y hora.
- Validación básica de prompts y archivos.
- Cabeceras de seguridad y endpoint `/health` para despliegue.

## Configuración

1. En Supabase, ejecuta `supabase.sql`.
2. Configura las variables de entorno del servidor usando `.env.example` como referencia.
3. Usa `SUPABASE_SECRET_KEY` únicamente como secreto del backend. Nunca la publiques en GitHub ni en el navegador.
4. Configura `POLLINATIONS_API_KEY` como secreto del servidor.
5. Instala dependencias con `npm install`.
6. Inicia con `npm start`.

## Render

El archivo `render.yaml` contiene la configuración base para desplegar la aplicación en Render. Las claves y contraseñas deben introducirse en Environment/Secrets de Render, no en el repositorio.

## Base de datos y Storage

El esquema `supabase.sql` crea las tablas `users` y `generations` y el bucket privado `media`.

## Nota

El proyecto está preparado para despliegue, pero el funcionamiento de la generación depende de una clave válida y de la disponibilidad/condiciones del proveedor Pollinations AI.
