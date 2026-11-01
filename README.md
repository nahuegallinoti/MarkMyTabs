# Mark My Tabs

Administrador de marcadores para Chrome: rápido, elegante y fácil de usar. El nombre juega con la expresión inglesa “mark my words”. Reemplaza al administrador nativo con búsqueda instantánea, organización con arrastrar y soltar, detección de duplicados, modo oscuro e interfaz bilingüe.

![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue) ![Sin dependencias](https://img.shields.io/badge/dependencias-0-green)

## Novedades de la versión 1.2.0

- **Búsqueda desde la barra de direcciones**: escribe `mt`, un espacio y lo que buscas; Enter abre el marcador.
- **Menú contextual de Chrome**: clic derecho en una página o un enlace para guardarlo, o para guardar todas las pestañas de la ventana en una carpeta.
- **Guardar pestañas abiertas** en una carpeta nueva desde el popup, el botón «Agregar» o el menú contextual. Puedes elegir cuáles y omitir las ya guardadas. El permiso de pestañas se pide solo la primera vez que lo usas.
- **Selector de carpetas con búsqueda** en todos los diálogos (guardar, mover, importar), con atajos a las carpetas usadas hace poco. `Alt+M`, `Tab`, escribe «dev» y `Enter` guarda en «Dev».
- **Operadores de búsqueda**: `site:github.com`, `in:dev`, `is:folder` / `is:bookmark`, `-excluir` y `"frase exacta"`, en el administrador, el popup y la barra de direcciones.
- **Limpieza**: una sola vista para duplicados, **carpetas vacías** y **enlaces rotos**. La revisión de enlaces detecta páginas inexistentes, sitios caídos y direcciones que se mudaron (y las actualiza en un clic). Es opcional y pide permiso al usarla.
- **Abrir como grupo de pestañas** con el nombre de la carpeta, o todos en una ventana nueva.
- **Ordenar una carpeta por nombre** de forma permanente, con deshacer.
- **`Ctrl+Z`** deshace el último cambio (eliminar, mover, ordenar, importar…).
- **Pega enlaces** con `Ctrl+V` o **arrástralos** desde cualquier página hasta una carpeta para guardarlos.
- Orden por sitio, «Copiar como Markdown» y ventana de guardado que avisa si la página ya está guardada y dónde.

## Novedades de la versión 1.1.0

- **Respaldos e importación** desde el pie de la barra lateral: exporta toda la colección a JSON o HTML compatible con navegadores, o exporta una sola carpeta a HTML.
- **Importa JSON o HTML** con vista previa, elección de destino y opción de omitir URLs ya guardadas. Se crea una carpeta separada, se conserva la jerarquía y se puede deshacer. Si la escritura falla, se retira la importación parcial; si esa limpieza también falla, se avisa para revisar la carpeta. Hasta 20.000 elementos, 32 niveles y 10 MB por archivo. No se importan URLs ejecutables (`javascript:` o `data:`).
- **Carpetas fijadas**: acceso directo en la barra lateral desde «Fijar carpeta» o el menú contextual.
- **Búsqueda por ruta de carpeta**, filtros de marcadores/carpetas y búsqueda dentro de la carpeta actual. Los resultados se muestran de 400 en 400, sin el anterior corte de 300.
- **Popup mejorado**: pestañas Carpetas/Recientes, cambio de tema, limpieza de búsqueda, edición de nombre y carpeta al guardar, recuerdo del destino y deshacer el guardado o borrado rápido.
- **Guardado fiable**: los errores se muestran conservando el borrador y permiten reintentar. Se bloquean los envíos repetidos mientras se está guardando.
- **Accesibilidad**: foco contenido y restaurado en diálogos, menús y carpetas navegables con teclado, etiquetas para lectores de pantalla, mayor contraste y respeto a movimiento reducido.
- **Interfaz adaptable** a ventanas pequeñas y hover violeta en los controles. Las búsquedas del popup reutilizan la pestaña del administrador.
- **Duplicados más precisos**: se respetan las mayúsculas de las rutas y los fragmentos de las URLs, incluidos enlaces a instantes de YouTube.

Mark My Tabs administra los marcadores del navegador; la integración con el reproductor de YouTube pertenece al proyecto TubeMarks / YoutubeStar.

Los respaldos conservan nombres, URLs y jerarquía de carpetas. No incluyen las preferencias de la interfaz; Chrome asigna nuevas fechas al importar.

## Instalación

1. Abre `chrome://extensions` en Chrome.
2. Activa el **Modo de desarrollador** (arriba a la derecha).
3. Haz clic en **Cargar descomprimida** y elige esta carpeta.
4. Listo: se abre el administrador automáticamente. Fija el ícono en la barra para tener el buscador rápido a mano.

Requiere Chrome 116 o posterior para localizar la página del administrador sin ampliar los permisos de navegación.

## Funciones

### Administrador (página completa)
- **Búsqueda instantánea** sobre títulos y URLs, tolerante a acentos (`diseno` encuentra «Diseño»), con resaltado de coincidencias, ruta de carpeta en cada resultado y operadores (`site:`, `in:`, `is:`, `-palabra`, `"frase"`).
- **Árbol de carpetas** con contadores, expandir/contraer y menú contextual (renombrar, mover, eliminar, abrir todos…).
- **Vistas**: carpeta actual, Todos los marcadores, Recientes (agrupados por fecha) y **Limpieza** (duplicados, carpetas vacías y enlaces rotos).
- **Cuadrícula o lista**, orden personalizado, por nombre o por fecha.
- **Arrastrar y soltar**: reordena dentro de una carpeta o suelta sobre cualquier carpeta del árbol (con expansión automática al mantener).
- **Selección múltiple** (Ctrl+clic, Shift+clic, Ctrl+A) con barra de acciones: abrir, mover, copiar enlaces, eliminar.
- **Deshacer** cualquier eliminación, movimiento u orden desde el aviso o con `Ctrl+Z`.
- **Abrir carpetas** como grupo de pestañas o en una ventana nueva; **ordenarlas por nombre** de forma permanente.
- **Guardar pestañas abiertas**, pegar enlaces (`Ctrl+V`) o arrastrarlos desde otras páginas.
- **Tema claro/oscuro** (detecta el del sistema, se puede alternar).
- **English / Español**: cambia el idioma al instante desde el administrador, el popup o la ventana de guardado.
- Todo editable: crear/editar marcadores y carpetas, con validación de URL.

### Popup (clic en el ícono)
- **Árbol de carpetas explorable**: expande y navega tus carpetas sin salir del popup; recuerda qué carpetas dejaste abiertas y hasta dónde habías scrolleado.
- Buscador con navegación completa por teclado: `↑ ↓` moverse, `→ ←` expandir/contraer carpetas, `Enter` abrir.
- Guardar/quitar la página actual con un clic en la estrella, o elegir nombre y carpeta con el selector con búsqueda.
- Guardar todas las pestañas de la ventana en una carpeta.

### Integración con Chrome
- **Omnibox**: `mt` + espacio en la barra de direcciones busca en tus marcadores.
- **Menú contextual**: guardar la página, un enlace o todas las pestañas.
- Botón para contraer todas las carpetas y acceso directo al administrador.

## Atajos de teclado

| Atajo | Acción |
|---|---|
| `Alt+B` | Abrir el administrador desde cualquier pestaña |
| `Alt+M` | Abrir el diálogo para guardar o editar la página actual; permite elegir carpeta o quitar el marcador |
| `Ctrl+K` o `/` | Enfocar el buscador |
| `↑ ↓ ← →` | Navegar entre elementos |
| `Enter` | Abrir el elemento enfocado |
| `Espacio` | Seleccionar/deseleccionar |
| `Ctrl+A` | Seleccionar todo |
| `Ctrl+Z` | Deshacer el último cambio |
| `Ctrl+V` | Pegar enlaces en la carpeta actual |
| `mt` + espacio | Buscar desde la barra de direcciones |
| `F2` | Editar el elemento enfocado |
| `Supr` | Eliminar (con opción de deshacer) |
| `Esc` | Cerrar menú/modal, limpiar selección o búsqueda |

> Si `Alt+B` o `Alt+M` no funcionan, otro programa puede estar usándolos: cámbialos en `chrome://extensions/shortcuts`.

## Desarrollo

No hay build ni dependencias: JavaScript vanilla + Manifest V3.

```
manifest.json        configuración de la extensión
background.js        service worker: atajos, omnibox, menú contextual, pestaña única del administrador
manager/             la app principal (HTML/CSS/JS)
popup/               buscador rápido del ícono
common/              utilidades compartidas, tema y datos simulados
common/backup.js     importación y exportación JSON/HTML
common/search.js     búsqueda y operadores (también la usa el omnibox)
common/folder-picker.js  selector de carpetas con búsqueda y recientes
manager/links.js     revisión de enlaces rotos
icons/               íconos generados
tools/dev-server.js  servidor estático para previsualizar la UI
```

Para trabajar en la interfaz sin recargar la extensión:

```bash
node tools/dev-server.js
```

y abre `http://localhost:5173`. Fuera de Chrome-extensión, la app usa datos simulados (`common/mock.js`) que imitan la API `chrome.bookmarks`, así que toda la UI es navegable.

### Comprobaciones y paquete

Con el servidor de desarrollo activo, Python y Playwright instalados:

```powershell
python tests/browser_test.py
```

Si ya tienes un Chromium de pruebas instalado, configura `MMT_TEST_CHROMIUM` con la ruta a su ejecutable. Las pruebas verifican los flujos con datos simulados y cargan la extensión real en un perfil temporal separado. No acceden a tus marcadores personales.

Para generar el ZIP instalable/publicable, con los archivos de la extensión:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/package.ps1
```

El archivo resultante es `mark-my-tabs-1.2.0.zip`. Para instalarlo localmente, descomprímelo y usa **Cargar descomprimida**. Si ya tienes la extensión cargada desde esta carpeta, pulsa **Recargar** en `chrome://extensions`.

## Permisos

- `bookmarks` — leer y administrar tus marcadores (es el propósito de la extensión).
- `favicon` — mostrar los favicons que Chrome ya tiene en caché.
- `storage` — recordar la pestaña del administrador para no duplicarla.
- `activeTab` — leer título y URL de la pestaña activa solo cuando usas la extensión (atajo `Alt+M`, el popup o el menú contextual).
- `contextMenus` — opciones «Guardar página/enlace/pestañas» en el clic derecho.
- `tabGroups` — poner nombre al grupo cuando abres una carpeta como grupo de pestañas.
- `tabs` *(opcional)* — se pide solo al usar «Guardar pestañas abiertas», para leer títulos y URLs de la ventana.
- Acceso a sitios http/https *(opcional)* — se pide solo al revisar enlaces rotos; cada consulta va directo al sitio guardado, sin cookies.

Ninguno de los permisos nuevos obligatorios muestra advertencias al actualizar. Nada sale de tu navegador hacia nosotros: sin analytics, sin servidores, sin cuentas.

## Privacidad

Consulta la [política de privacidad de Mark My Tabs](https://nahuegallinoti.github.io/MarkMyTabs/privacy-policy/).
