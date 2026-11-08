# Línea de comandos y agentes

Cada instalación trae un comando `ieumoffice` que maneja los mismos motores que la ventana: los mismos analizadores, el mismo escritor, el mismo renderizador. Un archivo que guarda la aplicación y un archivo que escribe el comando son el mismo archivo, y una comprobación que supera el panel de IA de la aplicación la supera también el comando.

```sh
ieumoffice --help          # every command
ieumoffice guide slides    # the op reference, for writing your own
```

`ieumoffice --help` muestra toda la superficie en una sola pantalla: cada comando con una línea que dice lo que hace, y luego las opciones globales y los códigos de salida.

## Cómo obtener el comando

El comando viene dentro de la aplicación. Para llamarlo por su nombre, ejecute una vez `ieumoffice install-cli`: en Windows añade la carpeta que contiene el comando a su `PATH` de usuario, y los terminales que abra después lo encuentran. **Configuración ▸ Integraciones** muestra si su terminal ya encuentra el comando y, si no, la línea exacta que hay que ejecutar.

Los agentes de codificación no necesitan ese paso. La aplicación anota dónde está el comando en `~/.ieumoffice/launcher`, y ellos lo encuentran ahí.

## Los comandos que conviene conocer

| Comando           | Qué hace                                                                                                                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open`            | Abre un documento en la aplicación; arranca la aplicación si no está en marcha.                                                                                                                                                                                                 |
| `selection`       | Lo que el usuario tiene seleccionado en ese archivo ahora mismo, mientras la aplicación está en marcha: el puntero al «este» / «aquí». Devuelve un rango de bloques, un rango de la hoja, elementos de una diapositiva o una página, según el editor en el que esté el archivo. |
| `convert`         | Convierte entre formatos usando los motores de la propia aplicación.                                                                                                                                                                                                            |
| `create`          | Crea un documento a partir de contenido estructurado.                                                                                                                                                                                                                           |
| `render`          | Un PNG por página, tal como los maqueta el renderizador.                                                                                                                                                                                                                        |
| `pdf`             | Lee la capa de texto de un PDF página a página, sin ningún proceso de la aplicación.                                                                                                                                                                                            |
| `read-url`        | Lee el texto de una página web desde la línea de comandos — un artículo, un documento o el enlace de una skill; imprime el texto y continúa con `--offset`.                                                                                                                     |
| `info`            | Metadatos y un resumen de la estructura de un documento.                                                                                                                                                                                                                        |
| `search`          | Búsqueda web o de imágenes: la búsqueda gratuita de forma predeterminada, o el proveedor de búsqueda cuya clave haya seleccionado en la aplicación.                                                                                                                             |
| `image` / `media` | Genera una imagen, o describe y hace preguntas sobre un archivo de imagen, vídeo o audio.                                                                                                                                                                                       |
| `merge`           | Rellena los marcadores de posición `{{key}}` de una plantilla `.docx`, `.pptx` o `.xlsx`.                                                                                                                                                                                       |
| `capabilities`    | Informa de qué funciones de IA (búsqueda, generación de imágenes, análisis de imágenes y de vídeo) están disponibles en esta máquina, y por qué vía.                                                                                                                            |
| `guide`           | La referencia de ops y las guías de diseño, generadas a partir de las mismas definiciones que el ejecutor usa para validar, así que no pueden apartarse de lo que `apply` acepta. `--json` la devuelve con el esquema de cada op.                                               |
| `install-cli`     | Pone `ieumoffice` en el `PATH`.                                                                                                                                                                                                                                                 |
| `skill`           | Lista los agentes de programación encontrados en esta máquina e instala o actualiza en ellos la skill de GenOffice.                                                                                                                                                             |
| `mcp`             | Publica todos los comandos como una herramienta del Model Context Protocol. Vea **Conectar un agente de programación**.                                                                                                                                                         |

## Edición: documentos, hojas, presentaciones

`ieumoffice docs`, `ieumoffice sheet` y `ieumoffice slides` leen y escriben por la misma vía de escritura que usa la aplicación, y comparten un mismo vocabulario: una **op** es una edición suelta, y una **spec** es una lista de ops que se aplican en orden.

```sh
ieumoffice sheet read report.xlsx
ieumoffice slides apply deck.pptx --ops ops.json --dry-run
ieumoffice docs apply brief.docx --ops ops.json
```

`--dry-run` informa de lo que haría un lote y no escribe nada, que es la forma barata de revisar una spec antes de aplicarla. El panel de IA de la aplicación funciona exactamente con estas ops, así que todo lo que puede pedirle, usted puede programarlo.

## Los comandos de búsqueda, imagen y medios

`search`, `image` y `media` usan lo que esté configurado en la aplicación, en Configuración ▸ IA ▸ Avanzado:

- `search` funciona siempre. Usa la búsqueda gratuita de forma predeterminada, o el proveedor de búsqueda cuya clave haya seleccionado.
- `image` necesita la clave de un proveedor de imágenes. En esta versión una suscripción no genera imágenes.
- `media` con una imagen usa un proveedor con clave cuando hay uno configurado. Solo usa su suscripción de Claude o Codex si usted lo ha permitido, y eso está **desactivado de forma predeterminada**; [Conectar un agente de programación](help://mcp) explica el interruptor y sus límites.
- `media` con vídeo o audio necesita un proveedor con clave que admita vídeo.

`ieumoffice capabilities --json` informa de todo esto sin llamar a ninguna IA. Su `detail` contiene:

| Campo                                                                            | Qué indica                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search`, `image_search`, `image_generation`, `image_analysis`, `video_analysis` | Para cada función: `available`; `via`, quién responde; `route`, uno de los valores `free`, `key` o `subscription`; `metered: true` si es un inicio de sesión de pago por consumo; y, cuando la función no está disponible, `message`, el texto con el que responde el propio comando. |
| `media_analysis`                                                                 | Se mantiene para scripts antiguos: lo mismo que `image_analysis`, o que `video_analysis` cuando solo funciona el vídeo.                                                                                                                                                               |
| `automatic_calls`                                                                | `subscription_enabled` y, mientras esté activado, `used`, el número de solicitudes automáticas atendidas en la última hora (solo informativo); `limit` y `remaining` son siempre `null`.                                                                                              |
| `app`                                                                            | `available`: si la aplicación está instalada donde el comando puede iniciarla.                                                                                                                                                                                                        |
| `settings_path`                                                                  | El archivo de ajustes del que se leyeron estas respuestas.                                                                                                                                                                                                                            |

Cuando `image` o `media` no pueden ejecutarse, el comando termina con el código 4 y `error: "app_unavailable"`, y `detail.errorCode` dice por qué. `unavailable` significa que no hay nada configurado para esa función, así que volver a intentarlo no servirá. `rate-limit` viene con `detail.resetsAt`, el momento (en milisegundos) en que las solicitudes vuelven a ser posibles.

## Qué guarda en este PC

Los dos archivos están en la carpeta `.ieumoffice`, dentro de su carpeta de usuario:

- `~/.ieumoffice/launcher` anota dónde está el comando de la aplicación, para que un agente de codificación lo encuentre aunque no esté en su `PATH`.
- `~/.ieumoffice/cli-audit.jsonl` recibe una línea por cada comando ejecutado —el comando, sus argumentos y el resultado—, para que después pueda ver qué hizo un agente.

## Model Context Protocol

`ieumoffice mcp` publica todos los comandos como herramientas de MCP, y `ieumoffice mcp install <agent|all>` la registra en la configuración propia de un agente de programación. Vea **Conectar un agente de programación** para ese lado.

## Lo que el comando no hace

Lee y escribe el archivo. No es la aplicación: no hay ventana, y el diálogo de actualización de la aplicación no se aplica. Todo lo que necesite la ventana —el panel de IA, la revisión de calidad de una diapositiva renderizada— tiene que esperar a que abra el archivo. `ieumoffice render` le da los píxeles sin ella, y `ieumoffice slides` audita por su cuenta la disposición de una presentación.
