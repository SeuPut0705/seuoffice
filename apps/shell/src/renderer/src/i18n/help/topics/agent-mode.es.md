# Modo agente

El agente toma como proyecto una carpeta que usted elige y ejecuta en ella el Claude Code o el Codex de este PC. La IA lee por sí misma el material de la carpeta, crea archivos nuevos, usa habilidades y scripts, y modifica los documentos abiertos en GenOffice. Úselo para trabajos que se apoyan en mucho material.

## Antes de empezar

- El programa Claude Code o Codex conectado en **Configuración ▸ IA** (con la sesión iniciada con una suscripción de Claude o un plan de ChatGPT). El agente no usa ChatGPT conectado directamente en la aplicación. El tema «Conexión por suscripción» explica cómo hacerlo.
- Una carpeta con su material. No se pueden elegir una unidad entera, toda su carpeta personal ni carpetas con datos de inicio de sesión o de aplicaciones.

## Iniciar una sesión

1. En la barra lateral izquierda de Inicio, haga clic en **Agente**. La ventana del agente se abre aparte.
2. Haga clic en **Elegir una carpeta…** para seleccionar la carpeta del proyecto. Las carpetas que usó hace poco aparecen en **Carpetas recientes**.
3. En **Programa**, elija Claude Code o Codex. No se puede elegir un programa que no esté conectado.
4. En **Cuándo preguntarte**, elija cómo le pide permiso el agente (tabla de abajo).
5. La primera vez, lea **Antes de empezar** y haga clic en **Entendido**.
6. Haga clic en **Iniciar**, escriba lo que quiere que se haga y haga clic en **Enviar**.

Una ventana es una sesión. Al cerrar la ventana o hacer clic en **Detener**, la sesión termina, y el programa que GenOffice inició para ella también se cierra. Una sesión también termina tras 30 minutos sin enviar nada.

## Cómo pregunta el agente

| Opción                                                 | Lo hace sin preguntar                                                              | Pregunta antes                                                              |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Preguntar antes de cada comando** (predeterminada)   | Leer y escribir archivos en la carpeta del proyecto, modificar documentos abiertos | Ejecutar un comando o script, leer fuera de la carpeta del proyecto         |
| **Preguntar antes de escribir y de ejecutar comandos** | Leer archivos en la carpeta del proyecto, modificar documentos abiertos            | Escribir un archivo, ejecutar un comando o script, leer fuera de la carpeta |
| **Confiar en este proyecto**                           | Casi todo                                                                          | Leer fuera de la carpeta del proyecto                                       |

Cuando el agente pregunta, la ventana muestra lo que quiere hacer (el comando completo, la ruta del archivo). Haga clic en **Permitir** o **Rechazar**.

Elija lo que elija, el agente nunca:

- Sobrescribe el archivo de un documento abierto en una pestaña de GenOffice. Los documentos abiertos se modifican a través de la aplicación, así que el cambio se ve al instante en el editor y la función deshacer del editor lo revierte.
- Escribe fuera de la carpeta del proyecto.
- Toca los datos de inicio de sesión de Claude o de Codex, ni la carpeta de datos de GenOffice.

## Claude Code y Codex

- **Codex** ejecuta los comandos en su propio espacio aislado, incluidos los que usted permite. Solo puede escribir en la carpeta del proyecto, internet está bloqueado a menos que usted lo active, y no puede leer sus archivos personales fuera del proyecto. Al iniciar una sesión, GenOffice comprueba primero que este aislamiento funciona en este PC, y no se inicia si no funciona.
- **Claude Code** no puede aislar comandos en Windows. Un comando que usted permite puede llegar a todo el PC y a internet. Por eso, con **Confiar en este proyecto**, es el propio revisor de Claude Code el que comprueba cada acción en su lugar.

Un documento que alguien le envió puede llevar instrucciones ocultas que le piden a la IA hacer otra cosa. En una carpeta con material que no conoce, use una de las opciones que preguntan.

## Búsqueda web e internet

- **Claude Code** puede buscar en la web y leer páginas web, pero antes pregunta. Pregunta la primera vez que busca y por cada sitio cuyas páginas lee. En la pregunta, **Permitir búsquedas durante esta sesión** o **Permitir este sitio durante esta sesión** hace que no vuelva a preguntar durante el resto de la sesión. Con **Confiar en este proyecto**, decide el propio revisor de Claude Code.
- Cuando elige **Codex**, la pantalla de inicio muestra dos ajustes más.

| Ajuste                                | Opciones                                     | Al principio         |
| ------------------------------------- | -------------------------------------------- | -------------------- |
| **Búsqueda web**                      | Resultados guardados / En vivo / Desactivada | Resultados guardados |
| **Acceso a internet de los comandos** | Desactivado / Activado                       | Desactivado          |

- Los resultados guardados provienen de contenido web recopilado de antemano; En vivo busca en la web tal como está ahora.
- Ambos ajustes se recuerdan para cada carpeta de proyecto. Una carpeta que se usa por primera vez empieza con los valores de arriba.
- Con el acceso a internet de los comandos activado, los comandos que ejecuta Codex pueden llegar a internet. Con **Confiar en este proyecto** llegan sin preguntar, y unas instrucciones ocultas en un documento recibido podrían hacer que envíen sus datos al exterior. Esta advertencia aparece al activarlo. Actívelo solo cuando lo necesite. La habilidad integrada «Buscar habilidades» solo funciona con este ajuste activado.

## Notas del proyecto y habilidades

- Si la carpeta tiene un `CLAUDE.md` o un `AGENTS.md`, su contenido se le da al agente como instrucciones. Anote ahí lo que debe cumplirse siempre: el tono, los términos, el formato de los documentos que hay que crear.
- La ventana del agente usa las habilidades activadas en **Configuración ▸ Habilidades**. Claude Code y Codex reciben la misma lista. Encontrará más información sobre las habilidades en [Habilidades](help://skills).
- Las habilidades de `.claude/skills` y `.agents/skills` de la carpeta del proyecto se usan en esa sesión sin necesidad de activarlas.
- Si elige una habilidad con `/` o `$` en el cuadro de entrada, delante de su solicitud se añade una instrucción para leer y seguir esa habilidad.
- La lista de habilidades queda fijada al iniciar la sesión. Si activa o desactiva habilidades durante una sesión, aparece «Las habilidades modificadas se aplican a partir de la próxima sesión».
- Cuando el agente crea una habilidad, aparece una tarjeta de habilidad en la ventana; cuando encuentra una habilidad que vale la pena instalar, aparece una vista previa de instalación. No se guarda ni se instala nada hasta que hace clic en **Guardar** o **Instalar**, y una habilidad instalada está disponible a partir de la próxima sesión.
- Los programas que usan los scripts de una habilidad (Python, etc.) deben estar instalados en este PC.
- Si usó el agente en una versión anterior, la primera vez que abra la ventana del agente verá un aviso, una sola vez, que dice: «Las habilidades ahora se activan y desactivan en Configuración → Habilidades. Las habilidades de las carpetas de habilidades de Claude y Codex empiezan desactivadas.» **Abrir configuración** le lleva directamente allí.

## Archivos nuevos y documentos abiertos

- Los archivos nuevos que crea el agente se guardan en la carpeta del proyecto. Haga clic en **Abrir** en esa línea del registro de progreso para abrir el archivo en una pestaña de GenOffice.
- Para que se modifique un documento abierto, ábralo primero en GenOffice y nómbrelo en su petición.
- Un documento que abra durante una sesión se puede modificar a partir de su siguiente mensaje.

## Privacidad y consumo

- Lo que ocultó a la IA solo queda oculto cuando la aplicación lee para el agente un documento abierto en GenOffice. Los archivos que el agente lee por sí mismo de la carpeta se envían tal cual.
- Los términos de búsqueda web y las direcciones de las páginas leídas llegan a la empresa del programa y a esos sitios. Con el acceso a internet de los comandos de Codex activado, los datos pueden ir a cualquier lugar al que se conecte un comando.
- El agente trabaja en muchos pasos, así que gasta más del límite de su suscripción que el panel de IA. Cuando se agota el límite, la solicitud falla; el agente nunca pasa a otra IA ni a una conexión de pago.

## Si algo sale mal

| Lo que dice la ventana                                   | Qué hacer                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------- |
| **No conectado**                                         | Inicie sesión en ese programa en **Configuración ▸ IA**.      |
| **No se puede usar esta carpeta**                        | Elija una carpeta que solo contenga su material de trabajo.   |
| **Codex no puede abrir en este PC el entorno aislado**   | Actualice Windows o elija Claude Code.                        |
| **Has agotado el límite de tu suscripción**              | Vuelva a enviar cuando se restablezca el límite.              |
| **El programa es demasiado antiguo para el modo agente** | Actualice ese programa y luego haga clic en **Nueva sesión**. |
