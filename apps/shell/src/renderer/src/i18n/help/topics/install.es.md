# Instalación de GenOffice

Cada versión se publica en la [página de versiones](https://github.com/SeuPut0705/seuoffice/releases/latest) del proyecto en GitHub.

## Elija el archivo para su equipo

| Plataforma             | Requisitos                                   | Archivo                         |
| ---------------------- | -------------------------------------------- | ------------------------------- |
| **Windows**            | Windows 10 o posterior, Intel/AMD de 64 bits | `GenOffice-Setup-<version>.exe` |
| **Mac**, Apple Silicon | macOS 12 o posterior, chip M1 o más reciente | `GenOffice-<version>-arm64.dmg` |

Los demás archivos de la página de versiones (`.zip`, `.yml`, `.blockmap`) son los que usa la propia aplicación para actualizarse; no necesita descargarlos. Las versiones anteriores siguen en la página de versiones.

## En Windows

1. Descargue `GenOffice-Setup-<version>.exe` desde la página de versiones.
2. Ejecútelo. El instalador no está firmado digitalmente, así que Windows puede mostrar primero una ventana azul «Windows protegió su PC». Elija **Más información** y después **Ejecutar de todas formas**. El texto exacto depende de su versión de Windows.
3. Siga el instalador hasta el final.

Coloca GenOffice en el menú Inicio y registra `.docx`, `.xlsx`, `.pptx`, `.pdf` y formatos similares como aplicaciones predeterminadas, de modo que al hacer doble clic en un archivo este se abra en GenOffice.

Como el instalador no está firmado, ejecute solo uno que haya descargado de la página de versiones indicada arriba.

## Cuando Windows bloquea la descarga o la instalación

### Edge dice que el archivo «no se descarga habitualmente»

Microsoft Defender SmartScreen avisa así de un archivo que no ha visto descargar a mucha gente. La guía de Microsoft para conservar el archivo es esta:

1. Abra la lista de descargas de Edge (**Ctrl+J**), pulse **…** junto al archivo y elija **Conservar**.
2. En la ventana que se abre, pulse **Mostrar más** y después **Conservar de todos modos**. El archivo se queda en su carpeta Descargas.

Esa ventana también tiene un botón que informa de que el archivo es seguro. Solo abre la página de informes de Microsoft (`feedback.smartscreen.microsoft.com`) y no conserva el archivo. Cierre esa página y pulse **Mostrar más** en la ventana.

Si la ventana no tiene **Mostrar más** o no tiene **Conservar de todos modos**:

- En un PC que administra un centro educativo o una empresa, el administrador puede impedir que se omitan estas advertencias (una directiva de Edge). Entonces nadie en ese PC puede conservar el archivo; pida al administrador que lo instale o que lo permita.
- Si descarga desde la página de versiones con otro navegador, obtiene el mismo archivo.
- Si ninguna de las dos opciones funciona y es su propio PC, la guía de Microsoft para solucionar problemas de descarga permite, como último recurso, desactivar Microsoft Defender SmartScreen un momento: en Edge, abra **Configuración y más (…) ▸ Configuración ▸ Privacidad, búsqueda y servicios ▸ Seguridad**, desactive **Microsoft Defender SmartScreen**, descargue el archivo de nuevo y vuelva a activarlo enseguida. Mientras está desactivado, Edge no le avisa ni de las descargas ni de los sitios peligrosos, como las páginas de phishing.

### Aparece una ventana «Windows protegió su PC»

Microsoft Defender SmartScreen muestra esta ventana la primera vez que ve un instalador sin firmar. Pulse **Más información** y aparece un botón **Ejecutar de todas formas**. En un PC que administra un centro educativo o una empresa, una configuración del administrador puede ocultar ese botón; consulte al administrador.

### El Control inteligente de aplicaciones lo bloquea

Cuando el Control inteligente de aplicaciones de Windows 11 está activado, detiene los instaladores sin firmar y no ofrece el camino de **Más información**. Microsoft indica que no hay forma de permitir una sola aplicación: la única opción es desactivar el Control inteligente de aplicaciones, en **Seguridad de Windows ▸ Control de aplicaciones y navegador ▸ Configuración del Control inteligente de aplicaciones**. Eso quita esta protección también para todas las demás aplicaciones. Con las actualizaciones recientes de Windows se puede volver a activar sin reinstalar Windows.

## En un Mac

Necesita macOS 12 (Monterey) o posterior. La versión para Mac no tiene firma de desarrollador de Apple, así que la primera vez que la abre macOS dice que no puede verificar que la aplicación no contenga malware y no la abre. Permítala una sola vez, como se indica a continuación.

1. Abra el dmg y arrastre `GenOffice.app` a la carpeta **Aplicaciones**.
2. Abra GenOffice desde la carpeta Aplicaciones. Cuando aparezca la advertencia, pulse **Listo**.
3. Abra **Ajustes del Sistema ▸ Privacidad y seguridad**. Hacia el final, junto a la línea que dice que GenOffice se bloqueó, pulse **Abrir igualmente** e introduzca la contraseña de su Mac. El botón aparece durante aproximadamente una hora después de intentar abrir la aplicación.
4. En la ventana que vuelve a aparecer, pulse **Abrir**. A partir de entonces se abre sin advertencia.

En macOS 12 el lugar es **Preferencias del Sistema ▸ Seguridad y privacidad ▸ General**, y allí el botón es **Abrir igualmente**.

Si macOS dice que la aplicación «está dañada y no se puede abrir», no la mueva a la papelera. Ejecute la línea siguiente en Terminal, vuelva a abrir la aplicación y permítala como se indica arriba. Quita la marca que macOS añade a los archivos descargados de internet.

```sh
xattr -dr com.apple.quarantine /Applications/GenOffice.app
```

Si macOS dice que la aplicación no es compatible con este Mac, compruebe **Acerca de este Mac**. GenOffice solo funciona en un Mac con Apple Silicon (M1 o posterior) y macOS 12 o posterior; no funciona en un Mac Intel ni con macOS 11 o anterior.

También en un Mac:

- Las tarjetas de conexión de IA no tienen botón de instalación. Siga el enlace a la guía oficial de instalación que aparece en la tarjeta para instalar Claude Code o Codex. La aplicación de escritorio de Claude no es Claude Code, así que hay que instalar Claude Code aunque ya tenga la aplicación de escritorio.
- El inicio de sesión termina en el navegador. Si el navegador le pide pegar un código, ejecute usted mismo `claude auth login` o `codex login` en Terminal. Vea [Conexión por suscripción](help://subscription).

## Actualizaciones

- GenOffice busca una versión más reciente en la misma página de versiones de GitHub. Cuando se publica una, **Configuración ▸ Acerca de** la ofrece: pulse **Actualizar a …**, espere a que termine la descarga y pulse **Reiniciar e instalar**. En Windows, una ventana muestra el progreso de la instalación; al terminar, GenOffice se vuelve a abrir con los documentos que tenía abiertos. En Mac, la aplicación se cierra, se reemplaza por la nueva versión y se vuelve a abrir con los documentos que tenía abiertos. Esto funciona con una aplicación en la carpeta Aplicaciones; si la abrió directamente desde la imagen de disco, se le indicará la página de descargas. La actualización solo se instala cuando pulsa ese botón, nunca al cerrar la aplicación sin más.
- **Menú (☰) ▸ Buscar actualizaciones** hace la comprobación cuando usted lo pida. En un Mac es **Ayuda ▸ Buscar actualizaciones**.
- Cuando la comprobación falla —no hay red, o aún no se ha publicado nada—, no ocurre nada y la aplicación sigue funcionando como antes.
- Las actualizaciones tampoco están firmadas digitalmente. Antes de instalar una, la aplicación compara el archivo descargado con la suma de comprobación publicada con esa versión.
- Si **Reiniciar e instalar** cierra la aplicación pero la nueva versión no aparece, el siguiente inicio lo indica y vuelve a ofrecer la actualización. Esta vez el instalador se abre en su propia ventana, para que pueda seguirlo y responder a una solicitud de administrador. Si tampoco funciona, la ventana de actualización remite a la página de descargas; instalar con el archivo de allí conserva su configuración y sus documentos. Lo que hizo el actualizador queda escrito en `update-log.txt`, en la carpeta de datos de la aplicación (escriba `%APPDATA%\GenOffice` en la barra de direcciones del Explorador de archivos para abrirla). Adjunte ese archivo al informar del problema.

## La compilación que está ejecutando

**Configuración ▸ Acerca de** es donde la aplicación informa de la versión que tiene, del canal que sigue y de dónde vive el proyecto. También nombra el proyecto de código abierto en el que se basa esta aplicación.

## La línea de comandos viene incluida

Cada instalación trae un comando `ieumoffice` que habla con los mismos motores que la ventana, de modo que ambos nunca discrepan sobre un archivo. `ieumoffice install-cli` lo pone en su `PATH`. Vea [Línea de comandos y agentes](help://cli) para saber qué puede hacer.
