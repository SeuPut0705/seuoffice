# El editor HTML

El editor HTML abre .html / .htm con dos modos: **Vista previa** (la página renderizada) y **Código**.

- **Vista previa**: renderizado real; las hojas de estilo y las imágenes relativas se cargan junto al archivo.
- **Inspector de la vista previa**: haga clic para seleccionar un elemento, doble clic para editar su texto en el sitio, borrarlo con la barra de herramientas y Preguntar a la IA sobre la selección.
- **Diapositivas**: una página de diapositivas muestra una lista de diapositivas a la izquierda de la vista previa, dibujada por la propia página; haga clic en una para mostrarla. Una edición que recarga la vista previa vuelve a la diapositiva en la que estaba, y las teclas que escribe en el texto de una diapositiva nunca la pasan.
- **Modo de código**: edite el HTML; ctrl+F para buscar, Reemplazar todo guarda el marcado reescrito.
- **Guardar**: fiel byte a byte (se conservan el BOM, los CRLF y el salto de línea final); los guardados sin cambios no reescriben.
- **Zoom**: ctrl+rueda o pellizco escala la vista previa; ctrl+Z dentro de la vista previa deshace la última edición.
- **Ocultar a la IA**: en modo código, clic derecho sobre una selección — contenidos, valores de atributo, cadenas de script — y el modelo ve un marcador; la página renderizada nunca cambia (detalles en el capítulo del panel de IA).

## La barra de herramientas

Haga clic en cualquier elemento de la vista previa y una barra de herramientas flota por encima:

![La barra de herramientas flotante sobre un elemento seleccionado](img/html-toolbar.png)

- **Archivo e historial**: Guardar, Guardar como, Deshacer, Rehacer, Buscar; el interruptor de **Autoguardado** escribe los cambios a intervalos.
- Conmutador **Vista previa / Código**; **Pantalla completa** muestra la página a pantalla completa.
- **Formato**: negrita, cursiva, aumentar/reducir el tamaño de fuente; el **panel de estilo** del elemento seleccionado (colores y más).
- **Insertar**: título, párrafo, tabla, imagen (por enlace), más.
- **Acciones de imagen** (con una imagen seleccionada): recortar, **Quitar fondo**, reemplazar, bloquear proporción.
- **Acciones de elemento** (con un elemento seleccionado en el inspector de la vista previa): eliminar, duplicar, subir/bajar.
- **Botón de IA**: abre el panel de IA; pregunte directamente sobre el elemento seleccionado.

## Exportar

Menú Archivo, todo local y todo pregunta dónde poner el resultado:

- **Exportar como Word…** y **Exportar como PDF…** escriben un .docx o .pdf de verdad.
- **Exportar como ODT…** escribe un .odt (texto OpenDocument) con la misma conversión que la exportación a Word; si algo cambia o se pierde por el camino, verá la lista y confirmará antes.
- **Exportar como HTML de archivo único…** escribe un único .html con las imágenes incrustadas. No sobrescribirá el archivo que tengas abierto ahora y te dice cuántas imágenes no pudo incrustar.

## Insertar esqueleto

Para una página en blanco, **Insertar ▸ Insertar esqueleto** escribe un documento mínimo en modo estándar:

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title></title>
  </head>
  <body></body>
</html>
```

Cada parte está ahí por un motivo, y por eso es un comando y no algo que haya que escribir a mano:

- el **doctype**, o la vista previa se ejecuta en modo quirks, donde el dimensionado de las cajas y la disposición de las tablas siguen reglas distintas de las que espera;
- el **`lang`**, o un lector de pantalla no tiene con qué idioma leer la página, y el navegador elige una fuente y un corrector ortográfico para el idioma equivocado;
- el **charset**, o una página de texto no latino puede mostrarse con los caracteres corruptos (mojibake).

La etiqueta meta de viewport se omite a propósito: esto se renderiza en un panel de escritorio, sin ningún viewport móvil que pueda afectar.

El `lang` sigue el idioma de la interfaz de la aplicación, así que el esqueleto que inserte es aquel para el que sus herramientas ya están configuradas. Edítelo libremente después.

El elemento solo aparece en modo edición, y solo mientras el documento esté vacío: una vez que hay contenido, no hay nada en lo que insertar un esqueleto.

## Editar ecuación

Escriba visualmente o edite LaTeX. El HTML guarda el código para editarlo después.

Elija Insertar ecuación en la barra, use el campo visual, las plantillas o LaTeX y aplique. Pulse una ecuación guardada en la vista previa para editarla. Para insertarla en línea, seleccione un párrafo y desactive la línea aparte; se añadirá al final del párrafo.

Una expresión que el compositor no admite no se pierde: la ecuación conserva su código LaTeX y muestra el texto sin formato en la página, para volver a abrirla y corregirla.
