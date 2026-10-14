# Biblioteca colaborativa de La Movida de SST+

Sitio: https://drive.movidasst.com. Elaborado por David Linares Brea.

## Comportamiento

- Los contadores de Inicio incluyen toda la biblioteca y sus subcarpetas. Dentro de una carpeta se muestran sus elementos directos.
- La búsqueda por nombre puede abarcar toda la biblioteca o la carpeta actual; ignora mayúsculas y tildes. Los resultados globales incluyen su ruta.
- Las carpetas tienen enlaces permanentes `#folder=ID`. Las listas grandes muestran 60 archivos inicialmente y permiten cargar más.
- Sesiones verificadas en servidor: dos horas, renovables hasta ocho horas desde el ingreso inicial. El código y la cédula no se guardan en el navegador.
- Bloqueo persistente tras cinco intentos por documento en diez minutos y límite de cincuenta solicitudes de ingreso por IP en ese período.
- El catálogo completo se guarda en servidor. Se revisa al superar una hora y al pulsar Actualizar; la actualización manual tiene un mínimo de cinco minutos entre intentos. Una actualización parcial o fallida conserva la versión completa anterior.

## Apariencia y herramientas de consulta

El banner usa una ilustración SVG ligera y la identidad de La Movida de SST+, adaptada a móvil. La vista Explorar mantiene la estructura de carpetas; Favoritos y Recientes abarcan toda la biblioteca. Cada carpeta indica el total de archivos de su árbol y sus subcarpetas directas. Compartir carpeta usa el enlace de la biblioteca y exige que quien lo abre ingrese.

Los favoritos se guardan en `localStorage` bajo un identificador estable de la cuenta que entrega el servidor, sin guardar cédula ni código. Persisten en ese navegador y no se sincronizan entre dispositivos. Al cerrar sesión se limpia su representación en memoria; otra cuenta usa un conjunto separado. Si el navegador bloquea el almacenamiento, se informa y no se simula que fueron guardados.

Recientes distingue modificación en Google Drive e incorporación observada por el catálogo. `addedAt` empieza a registrarse para nuevos identificadores después de activar `trackingEnabledAt`; los recursos existentes conservan una fecha de incorporación desconocida. No se interpreta `modifiedTime` ni la creación de Google como incorporación. La fecha se conserva en posteriores actualizaciones completas del catálogo.

Los filtros separan documentos, PDF, imágenes, hojas de cálculo, presentaciones, videos, audios y otros recursos. Nombres completos permite expandir los nombres en móvil y escritorio.

## Desarrollo y publicación

```sh
npm ci
npm run build
npm test
```

El CSS compilado está en `assets/app.css`; no se usa Tailwind CDN en producción. El JavaScript de la interfaz está en `assets/app.js`. GitHub Pages sirve `index.html` y los recursos locales.

El backend es la Edge Function `drive-api` de Supabase. Su código está en `supabase/functions/drive-api/index.js`, sin dependencias externas. La plataforma no exige JWT de Supabase porque la aplicación usa credenciales propias; el handler valida una sesión opaca de 256 bits contra su hash y vencimiento en la base de datos antes de devolver cualquier catálogo. El ingreso es la única operación pública y aplica límites persistentes en servidor.

`supabase/drive-security.sql` contiene el esquema reproducible y las funciones SQL. Las tablas tienen RLS, sin acceso ni ejecución de funciones para `anon` o `authenticated`; las operaciones se ejecutan únicamente desde el backend mediante `service_role`, usando variables de entorno proporcionadas por Supabase. La configuración de Google se guarda en `drive_config_v2`, con esos mismos permisos. No añadir claves privadas al repositorio.

Una primera actualización construye el catálogo desde la carpeta raíz configurada. Los accesos directos de Google se contabilizan como recursos, pero no se recorren fuera de la raíz. No se incluyen archivos en la papelera ni elementos inaccesibles para la integración.

Para bloquear el acceso de un integrante, un administrador puede agregar su identificador a `drive_access_blocks_v2`. Un vencimiento nulo representa un bloqueo indefinido. `integrantes.estado` es una ubicación geográfica y nunca se usa como condición de acceso.

## Verificación

`tests/drive-api.test.js` verifica rechazo de sesiones ausentes o falsas, hash de tokens, bloqueo, origen de solicitudes, paginación, subcarpetas y conservación del catálogo ante errores.

`tests/browser.cjs` verifica la interfaz con respuestas simuladas y un catálogo real, a 360, 390, 768 y 1440 píxeles. Requiere Playwright y un archivo de catálogo externo al repositorio:

```sh
CATALOG_FIXTURE=/ruta/catalog.json node tests/browser.cjs
```

Se pueden configurar `PLAYWRIGHT_MODULE`, `CHROMIUM_EXECUTABLE` y `QA_OUTPUT`. No guardar sesiones de prueba, cédulas, códigos ni catálogos capturados en GitHub.

## Alcance de la seguridad

El backend protege las consultas de esta aplicación. Los enlaces de Google Drive conservan los permisos definidos por sus propietarios. Si un archivo permite acceso público por enlace, proteger la biblioteca no convierte ese archivo en privado. La clave de Google utilizada por la versión anterior permanece en el historial de Git y debe rotarse en Google Cloud antes de afirmar que fue revocada. Cambiar permisos de Drive exige una estrategia de acceso a documentos y vistas previas para evitar interrumpir su uso.

No reactivar la función pública antigua `validar_acceso_drive`: el nuevo frontend usa exclusivamente `drive-api`.
